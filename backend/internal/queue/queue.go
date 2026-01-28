package queue

import (
	"fmt"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/rabbitmq/amqp091-go"
)

type QueueProjectFileMsg struct {
	Message       string            `json:"message"`
	ProjectID     int64             `json:"project_id"`
	CorrelationID string            `json:"correlation_id,omitempty"`
	BatchID       int               `json:"batch_id,omitempty"`
	TotalBatches  int               `json:"total_batches,omitempty"`
	ProjectFiles  *[]db.ProjectFile `json:"project_files,omitempty"`
	Operation     string            `json:"operation,omitempty"`
}

type QueueDescriptionJobMsg struct {
	ProjectID       int64   `json:"project_id"`
	CorrelationID   string  `json:"correlation_id"`
	JobID           int     `json:"job_id"`
	TotalJobs       int     `json:"total_jobs"`
	EntityIDs       []int64 `json:"entity_ids,omitempty"`
	RelationshipIDs []int64 `json:"relationship_ids,omitempty"`
}

func Init() *amqp091.Connection {
	user := util.GetEnv("RABBITMQ_USER")
	pass := util.GetEnv("RABBITMQ_PASSWORD")
	host := util.GetEnv("RABBITMQ_HOST")
	port := util.GetEnv("RABBITMQ_PORT")

	connURL := fmt.Sprintf(
		"amqp://%s:%s@%s:%s/",
		user,
		pass,
		host,
		port,
	)

	conn, err := amqp091.Dial(connURL)
	if err != nil {
		logger.Fatal("Failed to connect to RabbitMQ", "err", err)
	}

	return conn
}

func SetupQueues(ch *amqp091.Channel, queueNames []string) error {
	var err error

	err = ch.ExchangeDeclare(
		"pubsub", // name
		"topic",  // type
		false,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		logger.Fatal("ExchangeDeclare failed", "err", err)
	}

	queues := queueNames
	if len(queues) == 0 {
		queues = []string{"graph_queue", "delete_queue", "preprocess_queue", "description_queue"}
	}
	for _, name := range queues {
		_, err := ch.QueueDeclare(
			name,
			true,  // durable
			false, // autoDelete
			false, // exclusive
			false, // noWait
			nil,   // args
		)
		if err != nil {
			logger.Fatal("QueueDeclare failed", "queue", name, "err", err)
		}

		dlqName := name + "_dlq"
		_, err = ch.QueueDeclare(
			dlqName,
			true,
			false,
			false,
			false,
			nil,
		)
		if err != nil {
			logger.Fatal("QueueDeclare failed", "queue", dlqName, "err", err)
		}

		retryName := name + "_retry"
		_, err = ch.QueueDeclare(
			retryName,
			true,
			false,
			false,
			false,
			amqp091.Table{
				"x-message-ttl":             int32(10000),
				"x-dead-letter-exchange":    "",
				"x-dead-letter-routing-key": name,
			},
		)
		if err != nil {
			logger.Fatal("QueueDeclare failed", "queue", retryName, "err", err)
		}
	}

	return nil
}

func PublishFIFO(ch *amqp091.Channel, queueName string, data []byte) error {
	q, err := ch.QueueDeclare(
		queueName,
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		return err
	}

	publishing := amqp091.Publishing{
		ContentType:  "text/plain",
		Body:         data,
		DeliveryMode: amqp091.Persistent,
		Timestamp:    time.Now(),
	}

	err = ch.Publish(
		"",
		q.Name,
		false,
		false,
		publishing,
	)
	if err != nil {
		return err
	}

	return nil
}

func PublishTopic(ch *amqp091.Channel, topic string, data []byte) error {
	err := ch.ExchangeDeclare(
		"pubsub_exchange",
		"topic",
		false,
		true,
		false,
		false,
		nil,
	)
	if err != nil {
		return err
	}

	publishing := amqp091.Publishing{
		ContentType:  "text/plain",
		Body:         data,
		DeliveryMode: amqp091.Persistent,
		Timestamp:    time.Now(),
	}

	err = ch.Publish(
		"pubsub_exchange",
		topic,
		false,
		true,
		publishing,
	)
	if err != nil {
		return err
	}

	return nil
}
