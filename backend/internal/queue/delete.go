package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/leaselock"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphstorage "github.com/OFFIS-RIT/kiwi/backend/pkg/store/base"

	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rabbitmq/amqp091-go"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/graph"
)

func ProcessDeleteMessage(
	ctx context.Context,
	s3Client *awss3.Client,
	aiClient ai.GraphAIClient,
	ch *amqp091.Channel,
	conn *pgxpool.Pool,
	msg string,
) error {
	type deleteJsonMsg struct {
		ProjectID int64 `json:"project_id"`
	}

	data := new(deleteJsonMsg)
	err := json.Unmarshal([]byte(msg), &data)
	if err != nil {
		return err
	}
	projectId := data.ProjectID
	graphID := fmt.Sprintf("%d", projectId)

	q := db.New(conn)

	for {
		pending, err := q.GetPendingBatchesForProject(ctx, projectId)
		if err != nil {
			return fmt.Errorf("failed to check pending batches before delete: %w", err)
		}
		if len(pending) > 0 {
			logger.Info("[Queue] Delete waiting for in-flight batches", "project_id", projectId, "pending_batches", len(pending))
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
			continue
		}

		break
	}

	deletedFiles, err := q.GetDeletedProjectFiles(ctx, projectId)
	if err != nil {
		return err
	}
	fileKeys := make([]string, 0, len(deletedFiles))
	for _, file := range deletedFiles {
		fileKeys = append(fileKeys, file.FileKey)
	}

	graphClient, err := graph.NewGraphClient(graph.NewGraphClientParams{
		TokenEncoder:  "o200k_base",
		ParallelFiles: 1,
	})
	if err != nil {
		return err
	}

	storageClient, err := graphstorage.NewGraphDBStorageWithConnection(ctx, conn, aiClient, []string{})
	if err != nil {
		return err
	}

	_, err = q.UpdateProjectState(ctx, db.UpdateProjectStateParams{
		ID:    projectId,
		State: "update",
	})
	if err != nil {
		return err
	}
	defer q.UpdateProjectState(ctx, db.UpdateProjectStateParams{
		ID:    projectId,
		State: "ready",
	})

	start := time.Now()
	lockClient := leaselock.New(conn)
	lease, err := lockClient.Acquire(ctx, fmt.Sprintf("project:%d", projectId), leaselock.Options{
		TTL:         10 * time.Minute,
		RenewEvery:  4 * time.Minute,
		Wait:        true,
		TokenPrefix: fmt.Sprintf("delete/%d/", projectId),
	})
	if err != nil {
		return err
	}
	defer func() {
		_ = lease.Release(context.Background())
	}()

	err = graphClient.DeleteGraph(lease.Context, graphID, aiClient, storageClient)
	if err != nil {
		return err
	}
	duration := time.Since(start)

	logger.Info("[Queue] Delete and regenerate completed", "project_id", projectId, "duration_sec", duration.Seconds())

	for _, fileKey := range fileKeys {
		if err := storage.DeleteFile(ctx, s3Client, fileKey); err != nil {
			logger.Warn("[Queue] Failed to delete S3 file", "file_key", fileKey, "err", err)
		}
	}

	return nil
}
