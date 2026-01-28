package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
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

	logger.Debug("[Queue] Acquiring advisory lock for delete", "project_id", projectId)
	err = q.AcquireProjectLock(ctx, projectId)
	if err != nil {
		return fmt.Errorf("failed to acquire project lock: %w", err)
	}
	defer func() {
		if unlockErr := q.ReleaseProjectLock(ctx, projectId); unlockErr != nil {
			errMsg := unlockErr.Error()
			if strings.Contains(errMsg, "conn closed") {
				logger.Debug("[Queue] Failed to release project lock (connection closed, lock auto-released)", "project_id", projectId, "err", unlockErr)
			} else {
				logger.Error("[Queue] Failed to release project lock", "project_id", projectId, "err", unlockErr)
			}
		}
		logger.Debug("[Queue] Released advisory lock", "project_id", projectId)
	}()

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
	err = graphClient.DeleteGraph(ctx, graphID, aiClient, storageClient)
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
