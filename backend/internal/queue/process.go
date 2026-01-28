package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphstorage "github.com/OFFIS-RIT/kiwi/backend/pkg/store/base"

	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rabbitmq/amqp091-go"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/graph"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/s3"
)

func ProcessGraphMessage(
	ctx context.Context,
	s3Client *awss3.Client,
	aiClient ai.GraphAIClient,
	ch *amqp091.Channel,
	conn *pgxpool.Pool,
	msg string,
) error {
	data := new(QueueProjectFileMsg)
	err := json.Unmarshal([]byte(msg), &data)
	if err != nil {
		return err
	}
	projectId := data.ProjectID

	q := db.New(conn)

	if data.CorrelationID != "" {
		_ = q.UpdateBatchStatus(ctx, db.UpdateBatchStatusParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
			Column3:       "extracting",
		})
	}

	isUpdate := data.Operation == "update"
	statType := "graph_creation"
	projectState := "create"
	if isUpdate {
		statType = "graph_update"
		projectState = "update"
	}
	if _, err := q.UpdateProjectState(ctx, db.UpdateProjectStateParams{
		ID:    projectId,
		State: projectState,
	}); err != nil {
		logger.Warn("[Queue] Failed to update project state at graph start", "project_id", projectId, "state", projectState, "err", err)
	}

	s3Bucket := util.GetEnvString("AWS_BUCKET", "kiwi")
	s3L := s3.NewS3GraphFileLoaderWithClient(s3Bucket, s3Client)
	files := make([]loader.GraphFile, 0)

	for _, file := range *data.ProjectFiles {
		metadataText := ""
		if file.Metadata.Valid {
			metadataText = file.Metadata.String
		}

		ext := filepath.Ext(file.FileKey)
		ext = strings.ReplaceAll(ext, ".", "")
		ext = strings.ToLower(ext)

		switch ext {
		case "xlsx", "xls":
			baseName := strings.TrimSuffix(filepath.Base(file.FileKey), "."+ext)
			dir := filepath.Dir(file.FileKey)
			prefix := fmt.Sprintf("%s/%s_", dir, baseName)

			sheetFiles, err := storage.ListFilesWithPrefix(ctx, s3Client, prefix)
			if err != nil {
				return err
			}

			sheetIndex := 0
			for _, sheetFile := range sheetFiles {
				if !strings.HasSuffix(sheetFile, ".txt") {
					continue
				}
				f := loader.NewGraphDocumentFile(loader.NewGraphFileParams{
					ID:        fmt.Sprintf("%d-sheet-%d", file.ID, sheetIndex),
					FilePath:  sheetFile,
					MaxTokens: 500,
					Loader:    s3L,
					Metadata:  metadataText,
				})

				files = append(files, f)
				sheetIndex++
			}
		case "csv":
			key := file.FileKey
			base := filepath.Base(file.FileKey)
			nameWithoutExt := strings.TrimSuffix(base, filepath.Ext(base))
			name := fmt.Sprintf("%s.txt", nameWithoutExt)
			key = fmt.Sprintf("%s/%s", filepath.Dir(file.FileKey), name)

			f := loader.NewGraphCSVFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", file.ID),
				FilePath:  key,
				MaxTokens: 500,
				Loader:    s3L,
				Metadata:  metadataText,
			})
			files = append(files, f)
		case "jpg", "jpeg", "png", "bmp", "gif", "tiff", "heic", "webp":
			key := file.FileKey
			base := filepath.Base(file.FileKey)
			nameWithoutExt := strings.TrimSuffix(base, filepath.Ext(base))
			name := fmt.Sprintf("%s.txt", nameWithoutExt)
			key = fmt.Sprintf("%s/%s", filepath.Dir(file.FileKey), name)

			f := loader.NewGraphImageFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", file.ID),
				FilePath:  key,
				MaxTokens: 500,
				Loader:    s3L,
				Metadata:  metadataText,
			})
			files = append(files, f)
		case "mp3", "wav", "mpeg", "mpga", "m4a", "ogg", "webm":
			key := file.FileKey
			base := filepath.Base(file.FileKey)
			nameWithoutExt := strings.TrimSuffix(base, filepath.Ext(base))
			name := fmt.Sprintf("%s.txt", nameWithoutExt)
			key = fmt.Sprintf("%s/%s", filepath.Dir(file.FileKey), name)

			f := loader.NewGraphAudioFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", file.ID),
				FilePath:  key,
				MaxTokens: 500,
				Loader:    s3L,
				Metadata:  metadataText,
			})
			files = append(files, f)
		case "doc", "docx", "odt", "pptx", "pdf":
			key := file.FileKey
			base := filepath.Base(file.FileKey)
			nameWithoutExt := strings.TrimSuffix(base, filepath.Ext(base))
			name := fmt.Sprintf("%s.txt", nameWithoutExt)
			key = fmt.Sprintf("%s/%s", filepath.Dir(file.FileKey), name)

			f := loader.NewGraphDocumentFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", file.ID),
				FilePath:  key,
				MaxTokens: 500,
				Loader:    s3L,
				Metadata:  metadataText,
			})
			files = append(files, f)
		case "txt", "md":
			f := loader.NewGraphDocumentFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", file.ID),
				FilePath:  file.FileKey,
				MaxTokens: 500,
				Loader:    s3L,
				Metadata:  metadataText,
			})
			files = append(files, f)
		default:
			key := file.FileKey
			base := filepath.Base(file.FileKey)
			nameWithoutExt := strings.TrimSuffix(base, filepath.Ext(base))
			name := fmt.Sprintf("%s.txt", nameWithoutExt)
			key = fmt.Sprintf("%s/%s", filepath.Dir(file.FileKey), name)

			f := loader.NewGraphGenericFile(
				loader.NewGraphFileParams{
					ID:        fmt.Sprintf("%d", file.ID),
					FilePath:  key,
					MaxTokens: 500,
					Loader:    s3L,
				},
				file.Name,
			)
			files = append(files, f)
		}
	}

	tokenCount := 0
	for _, f := range files {
		fileID := f.ID
		if idx := strings.Index(fileID, "-sheet-"); idx != -1 {
			fileID = fileID[:idx]
		}
		id, err := strconv.ParseInt(fileID, 10, 64)
		if err != nil {
			return err
		}

		tokens, err := q.GetTokenCountOfFile(ctx, id)
		if err != nil {
			return err
		}
		tokenCount += int(tokens)
	}

	prediction, err := q.PredictProjectProcessTime(ctx, db.PredictProjectProcessTimeParams{
		Duration: int64(tokenCount),
		StatType: statType,
	})
	if err != nil {
		prediction = 0
	}
	logger.Info("[Queue] Prediction for graph operation", "operation", data.Operation, "tokens", tokenCount, "time_ms", prediction)

	if data.CorrelationID != "" {
		_ = q.UpdateBatchEstimatedDuration(ctx, db.UpdateBatchEstimatedDurationParams{
			CorrelationID:     data.CorrelationID,
			BatchID:           int32(data.BatchID),
			EstimatedDuration: prediction,
		})
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
	deleteStagedData := func() error {
		if data.CorrelationID == "" {
			return nil
		}
		return storageClient.DeleteStagedData(ctx, data.CorrelationID, data.BatchID)
	}
	if err := deleteStagedData(); err != nil {
		return fmt.Errorf("failed to cleanup staged data before extraction: %w", err)
	}

	graphID := fmt.Sprintf("%d", projectId)
	start := time.Now()

	logger.Debug("[Queue] Starting extraction phase", "project_id", projectId, "batch_id", data.BatchID)
	err = graphClient.ExtractAndStage(ctx, files, graphID, aiClient, storageClient, data.CorrelationID, data.BatchID)
	if err != nil {
		if data.CorrelationID != "" {
			_ = q.UpdateBatchStatus(ctx, db.UpdateBatchStatusParams{
				CorrelationID: data.CorrelationID,
				BatchID:       int32(data.BatchID),
				Column3:       "failed",
				ErrorMessage:  pgtype.Text{String: err.Error(), Valid: true},
			})
		}
		if cleanupErr := deleteStagedData(); cleanupErr != nil {
			logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
		}
		return err
	}

	logger.Debug("[Queue] Acquiring advisory lock", "project_id", projectId)
	err = q.AcquireProjectLock(ctx, projectId)
	if err != nil {
		if cleanupErr := deleteStagedData(); cleanupErr != nil {
			logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
		}
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

	if data.CorrelationID != "" {
		_ = q.UpdateBatchStatus(ctx, db.UpdateBatchStatusParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
			Column3:       "indexing",
		})
	}

	_, err = q.UpdateProjectState(ctx, db.UpdateProjectStateParams{
		ID:    projectId,
		State: projectState,
	})
	if err != nil {
		if cleanupErr := deleteStagedData(); cleanupErr != nil {
			logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
		}
		return err
	}
	err = graphClient.MergeFromStaging(ctx, files, graphID, aiClient, storageClient, data.CorrelationID, data.BatchID)
	if err != nil {
		if data.CorrelationID != "" {
			_ = q.UpdateBatchStatus(ctx, db.UpdateBatchStatusParams{
				CorrelationID: data.CorrelationID,
				BatchID:       int32(data.BatchID),
				Column3:       "failed",
				ErrorMessage:  pgtype.Text{String: err.Error(), Valid: true},
			})
		}
		if cleanupErr := deleteStagedData(); cleanupErr != nil {
			logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
		}
		return err
	}

	if cleanupErr := deleteStagedData(); cleanupErr != nil {
		logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
	}

	duration := time.Since(start)
	q.AddProcessTime(ctx, db.AddProcessTimeParams{
		ProjectID: projectId,
		Amount:    int32(tokenCount),
		Duration:  duration.Milliseconds(),
		StatType:  statType,
	})

	if data.CorrelationID != "" {
		_ = q.UpdateBatchStatus(ctx, db.UpdateBatchStatusParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
			Column3:       "completed",
		})

		allDone, checkErr := q.AreAllBatchesCompleted(ctx, data.CorrelationID)
		if checkErr == nil && allDone {
			_, err := KickoffDescriptionJobsForCorrelation(ctx, ch, conn, data.CorrelationID, projectId)
			if err != nil {
				return err
			}

			descDone, descErr := q.AreAllDescriptionJobsCompleted(ctx, data.CorrelationID)
			if descErr != nil {
				return descErr
			}
			if descDone {
				latestCorrelationID, latestErr := q.GetLatestCorrelationForProject(ctx, projectId)
				if latestErr != nil {
					logger.Warn("[Queue] Failed to fetch latest correlation for project", "project_id", projectId, "correlation_id", data.CorrelationID, "err", latestErr)
				} else if latestCorrelationID == data.CorrelationID {
					if _, err := q.UpdateProjectState(ctx, db.UpdateProjectStateParams{ID: projectId, State: "ready"}); err != nil {
						logger.Error("[Queue] Failed to set project state to ready", "project_id", projectId, "correlation_id", data.CorrelationID, "err", err)
					}
				}
			}
		}
	} else {
		fileIDs := make([]int64, 0, len(files))
		for _, f := range files {
			fileID := f.ID
			if idx := strings.Index(fileID, "-sheet-"); idx != -1 {
				fileID = fileID[:idx]
			}
			id, err := strconv.ParseInt(fileID, 10, 64)
			if err != nil {
				continue
			}
			fileIDs = append(fileIDs, id)
		}
		if err := storageClient.UpdateEntityDescriptions(ctx, fileIDs); err != nil {
			logger.Error("[Queue] Failed to update entity descriptions", "project_id", projectId, "err", err)
		}
		if err := storageClient.UpdateRelationshipDescriptions(ctx, fileIDs); err != nil {
			logger.Error("[Queue] Failed to update relationship descriptions", "project_id", projectId, "err", err)
		}
		if _, err := q.UpdateProjectState(ctx, db.UpdateProjectStateParams{ID: projectId, State: "ready"}); err != nil {
			logger.Error("[Queue] Failed to set project state to ready", "project_id", projectId, "err", err)
		}
	}

	return nil
}
