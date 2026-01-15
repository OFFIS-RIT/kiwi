package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/queue"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	oai "github.com/OFFIS-RIT/kiwi/backend/pkg/ai/ollama"
	gai "github.com/OFFIS-RIT/kiwi/backend/pkg/ai/openai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger/console"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pgxvec "github.com/pgvector/pgvector-go/pgx"
)

func main() {
	util.LoadEnv()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	debug := util.GetEnvBool("DEBUG", false)
	consoleLogger := console.NewConsoleLogger(console.ConsoleLoggerParams{
		Debug: debug,
	})
	logger.Init(consoleLogger)

	client := storage.NewS3Client(ctx)

	adapter := util.GetEnv("AI_ADAPTER")
	var aiClient ai.GraphAIClient

	switch adapter {
	case "ollama":
		client, err := oai.NewGraphOllamaClient(oai.NewGraphOllamaClientParams{
			EmbeddingModel:   util.GetEnv("AI_EMBED_MODEL"),
			DescriptionModel: util.GetEnv("AI_CHAT_DESCRIBE_MODEL"),
			ExtractionModel:  util.GetEnv("AI_CHAT_EXTRACT_MODEL"),
			ImageModel:       util.GetEnv("AI_IMAGE_MODEL"),

			BaseURL: util.GetEnv("AI_CHAT_URL"),
			ApiKey:  util.GetEnv("AI_CHAT_KEY"),
		})
		if err != nil {
			logger.Fatal("Could not create Ollama client", "err", err)
		}
		aiClient = client
	default:
		aiClient = gai.NewGraphOpenAIClient(gai.NewGraphOpenAIClientParams{
			EmbeddingModel:   util.GetEnv("AI_EMBED_MODEL"),
			DescriptionModel: util.GetEnv("AI_CHAT_DESCRIBE_MODEL"),
			ExtractionModel:  util.GetEnv("AI_CHAT_EXTRACT_MODEL"),
			ImageModel:       util.GetEnv("AI_IMAGE_MODEL"),

			EmbeddingURL: util.GetEnv("AI_EMBED_URL"),
			EmbeddingKey: util.GetEnv("AI_EMBED_KEY"),
			ChatURL:      util.GetEnv("AI_CHAT_URL"),
			ChatKey:      util.GetEnv("AI_CHAT_KEY"),
			ImageURL:     util.GetEnv("AI_IMAGE_URL"),
			ImageKey:     util.GetEnv("AI_IMAGE_KEY"),
		})
	}

	pgConn, err := pgxpool.New(ctx, util.GetEnv("DATABASE_URL"))
	if err != nil {
		logger.Fatal("Unable to connect to database", "err", err)
	}
	defer pgConn.Close()
	pgConn.Config().AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		return pgxvec.RegisterTypes(ctx, conn)
	}

	conn := queue.Init()
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		logger.Fatal("Failed to open channel", "err", err)
	}
	defer ch.Close()

	queues := []string{"graph_queue", "delete_queue", "preprocess_queue"}
	err = queue.SetupQueues(ch, queues)

	logger.Info("Checking for stale batches to recover...")
	if err := queue.RecoverStaleBatches(ctx, ch, pgConn); err != nil {
		logger.Error("Failed to recover stale batches", "err", err)
	}

	logger.Info("Listening for messages")

	consumerCh, err := conn.Channel()
	if err != nil {
		logger.Fatal("Failed to open consumer channel", "err", err)
	}
	defer consumerCh.Close()

	prefetch := int(util.GetEnvNumeric("WORKER_PREFETCH", 1))
	err = consumerCh.Qos(prefetch, 0, false)
	if err != nil {
		logger.Fatal("Failed to set QoS", "err", err)
	}

	type queuedMessage struct {
		msg       amqp.Delivery
		queueName string
	}

	messageChan := make(chan queuedMessage)

	for _, queueName := range queues {
		go func(qName string) {
			consumerTag := fmt.Sprintf("%s_consumer", qName)
			msgs, err := consumerCh.Consume(
				qName,
				consumerTag,
				false, // autoAck
				false, // exclusive
				false, // noLocal
				false, // noWait
				nil,   // args
			)
			if err != nil {
				logger.Fatal("Failed to start consuming", "queue", qName, "err", err)
			}

			for {
				select {
				case <-ctx.Done():
					logger.Info("Stopping consumer", "queue", qName)
					return
				case msg, ok := <-msgs:
					if !ok {
						logger.Info("Message channel closed", "queue", qName)
						return
					}
					messageChan <- queuedMessage{msg: msg, queueName: qName}
				}
			}
		}(queueName)
	}

	go func() {
		for {
			select {
			case <-ctx.Done():
				logger.Info("Stopping message processor")
				return
			case qm := <-messageChan:
				startTime := time.Now()
				logger.Info("Received message", "queue", qm.queueName)

				var processingErr error
				switch qm.queueName {
				case "preprocess_queue":
					processingErr = queue.ProcessPreprocess(ctx, client, aiClient, ch, pgConn, string(qm.msg.Body))
				case "graph_queue":
					processingErr = queue.ProcessGraphMessage(ctx, client, aiClient, ch, pgConn, string(qm.msg.Body))
				case "delete_queue":
					processingErr = queue.ProcessDeleteMessage(ctx, client, aiClient, ch, pgConn, string(qm.msg.Body))
				}

				if processingErr != nil {
					logger.Error("Error processing message", "queue", qm.queueName, "err", processingErr)
					queue.ResetBatchStatusForRetry(ctx, pgConn, qm.queueName, qm.msg.Body)
					handleProcessingError(consumerCh, qm.msg, qm.queueName)
				} else {
					err = qm.msg.Ack(false)
					if err != nil {
						logger.Error("Failed to ack message", "err", err)
					}
					logger.Info("Message processed successfully", "queue", qm.queueName)
				}

				metrics := aiClient.GetMetrics()
				aiDuration := time.Duration(metrics.DurationMs) * time.Millisecond
				aiHours := int(aiDuration.Hours())
				aiMinutes := int(aiDuration.Minutes()) % 60
				aiSeconds := int(aiDuration.Seconds()) % 60
				logger.Info(
					"AI Metrics",
					"input_tokens", metrics.InputTokens,
					"output_tokens", metrics.OutputTokens,
					"total_tokens", metrics.TotalTokens,
					"duration", fmt.Sprintf("%02d:%02d:%02d", aiHours, aiMinutes, aiSeconds),
				)

				processingDuration := time.Since(startTime)
				hours := int(processingDuration.Hours())
				minutes := int(processingDuration.Minutes()) % 60
				seconds := int(processingDuration.Seconds()) % 60
				logger.Info(
					"Processing time",
					"duration", fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds),
				)
				logger.Info("Waiting for next message")
				aiClient.ResetMetrics()
			}
		}
	}()

	<-ctx.Done()
	logger.Info("Shutdown signal received, exiting...")
}

func handleProcessingError(ch *amqp.Channel, msg amqp.Delivery, queueName string) {
	retries := 0
	if val, ok := msg.Headers["x-retries"]; ok {
		if v, ok := val.(int32); ok {
			retries = int(v)
		}
	}

	if retries >= 10 {
		dlqName := queueName + "_dlq"
		logger.Info("Sending message to DLQ", "dlq", dlqName)
		pubErr := ch.Publish(
			"",
			dlqName,
			false,
			false,
			amqp.Publishing{
				ContentType: "text/plain",
				Body:        msg.Body,
				Headers:     msg.Headers,
			},
		)
		if pubErr != nil {
			logger.Error("Failed to publish to DLQ", "dlq", dlqName, "err", pubErr)
			msg.Nack(false, true)
			return
		}
		msg.Ack(false)
		return
	}

	retryName := queueName + "_retry"
	headers := msg.Headers
	if headers == nil {
		headers = amqp.Table{}
	}
	headers["x-retries"] = retries + 1

	pubErr := ch.Publish(
		"",
		retryName,
		false,
		false,
		amqp.Publishing{
			ContentType: "text/plain",
			Body:        msg.Body,
			Headers:     headers,
		},
	)
	if pubErr != nil {
		logger.Error("Failed to publish to retry queue", "retry_queue", retryName, "err", pubErr)
		msg.Nack(false, true)
		return
	}
	msg.Ack(false)
}
