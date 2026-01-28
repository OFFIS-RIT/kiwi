package queue

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rabbitmq/amqp091-go"
)

func RecoverStaleBatches(
	ctx context.Context,
	ch *amqp091.Channel,
	conn *pgxpool.Pool,
) error {
	q := db.New(conn)

	staleBatches, err := q.GetStaleBatches(ctx)
	if err != nil {
		return fmt.Errorf("failed to get stale batches: %w", err)
	}

	if len(staleBatches) == 0 {
		logger.Debug("[Queue] No stale batches found")
		return nil
	}

	logger.Info("[Queue] Found stale batches", "count", len(staleBatches))

	for _, batch := range staleBatches {
		projectFiles, err := q.GetProjectFilesForBatch(ctx, batch.FileIds)
		if err != nil {
			logger.Error("[Queue] Failed to get project files for batch", "batch_id", batch.BatchID, "err", err)
			continue
		}

		if len(projectFiles) == 0 {
			logger.Warn("[Queue] No project files found for stale batch, skipping", "batch_id", batch.BatchID)
			continue
		}

		var targetQueue string
		switch batch.Status {
		case "preprocessing":
			err = q.ResetStaleBatchToPending(ctx, batch.ID)
			targetQueue = "preprocess_queue"
		case "extracting":
			err = q.ResetStaleBatchExtractingToPreprocessed(ctx, batch.ID)
			targetQueue = "graph_queue"
		case "indexing":
			err = q.ResetStaleBatchToPreprocessed(ctx, batch.ID)
			targetQueue = "graph_queue"
		default:
			continue
		}

		if err != nil {
			logger.Error("[Queue] Failed to reset batch status", "batch_id", batch.BatchID, "err", err)
			continue
		}

		files := make([]db.ProjectFile, len(projectFiles))
		copy(files, projectFiles)

		queueData := QueueProjectFileMsg{
			Message:       "Recovered stale batch",
			ProjectID:     batch.ProjectID,
			CorrelationID: batch.CorrelationID,
			BatchID:       int(batch.BatchID),
			TotalBatches:  int(batch.TotalBatches),
			ProjectFiles:  &files,
			Operation:     batch.Operation,
		}

		msgBytes, err := json.Marshal(queueData)
		if err != nil {
			logger.Error("[Queue] Failed to marshal queue message", "batch_id", batch.BatchID, "err", err)
			continue
		}

		err = PublishFIFO(ch, targetQueue, msgBytes)
		if err != nil {
			logger.Error("[Queue] Failed to republish batch", "batch_id", batch.BatchID, "queue", targetQueue, "err", err)
			continue
		}

		logger.Info("[Queue] Recovered stale batch", "batch_id", batch.BatchID, "project_id", batch.ProjectID, "queue", targetQueue)
	}

	return nil
}

func ResetBatchStatusForRetry(
	ctx context.Context,
	conn *pgxpool.Pool,
	queueName string,
	msgBody []byte,
) {
	var data QueueProjectFileMsg
	_ = json.Unmarshal(msgBody, &data)

	q := db.New(conn)

	switch queueName {
	case "preprocess_queue":
		if data.CorrelationID == "" {
			return
		}
		_ = q.ResetBatchToPending(ctx, db.ResetBatchToPendingParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
		})
	case "graph_queue":
		if data.CorrelationID == "" {
			return
		}
		_ = q.ResetBatchToPreprocessed(ctx, db.ResetBatchToPreprocessedParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
		})
	case "description_queue":
		var descMsg QueueDescriptionJobMsg
		if err := json.Unmarshal(msgBody, &descMsg); err != nil {
			return
		}
		if descMsg.CorrelationID == "" {
			return
		}
		_ = q.ResetDescriptionJobToPending(ctx, db.ResetDescriptionJobToPendingParams{
			CorrelationID: descMsg.CorrelationID,
			JobID:         int32(descMsg.JobID),
		})
	}
}
