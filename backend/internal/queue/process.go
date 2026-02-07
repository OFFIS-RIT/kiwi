package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/leaselock"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphstorage "github.com/OFFIS-RIT/kiwi/backend/pkg/store/pgx"

	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
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
) (err error) {
	data := new(QueueProjectFileMsg)
	if err = json.Unmarshal([]byte(msg), &data); err != nil {
		return err
	}
	projectId := data.ProjectID

	q := pgdb.New(conn)
	graphBatchClaimed := false
	defer func() {
		if err == nil || data.CorrelationID == "" || !graphBatchClaimed {
			return
		}
		updateCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if updateErr := q.UpdateBatchStatus(updateCtx, pgdb.UpdateBatchStatusParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
			Column3:       "failed",
			ErrorMessage:  pgtype.Text{String: err.Error(), Valid: true},
		}); updateErr != nil {
			logger.Warn("[Queue] Failed to mark graph batch as failed", "project_id", data.ProjectID, "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", updateErr)
		}
	}()

	isUpdate := data.Operation == "update"
	statType := "graph_creation"
	projectState := "create"
	if isUpdate {
		statType = "graph_update"
		projectState = "update"
	}

	s3Bucket := util.GetEnvString("AWS_BUCKET", "kiwi")
	s3L := s3.NewS3GraphFileLoaderWithClient(s3Bucket, s3Client)
	files := make([]loader.GraphFile, 0)
	excelSheetFileCounts := make(map[int64]int, len(*data.ProjectFiles))

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
			sort.Strings(sheetFiles)

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
				excelSheetFileCounts[file.ID]++
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

	// token_count is persisted per original project file ID in preprocess.
	// Excel sheet token counts are already aggregated into their parent file ID.
	// Keep deterministic order by following project file order and deduplicating.
	tokenFileIDs := make([]int64, 0, len(*data.ProjectFiles))
	tokenFileIDSeen := make(map[int64]struct{}, len(*data.ProjectFiles))
	for _, file := range *data.ProjectFiles {
		if _, ok := tokenFileIDSeen[file.ID]; ok {
			continue
		}
		tokenFileIDSeen[file.ID] = struct{}{}
		tokenFileIDs = append(tokenFileIDs, file.ID)
	}

	tokensByFileID := make(map[int64]int32, len(tokenFileIDs))
	tokenCount := 0
	if len(tokenFileIDs) > 0 {
		tokenRows, err := q.GetTokenCountsOfFiles(ctx, tokenFileIDs)
		if err != nil {
			return err
		}

		for _, row := range tokenRows {
			tokensByFileID[row.ID] = row.TokenCount
		}

		for _, id := range tokenFileIDs {
			if _, ok := tokensByFileID[id]; !ok {
				return fmt.Errorf("token count not found for file %d", id)
			}
		}

		for _, id := range tokenFileIDs {
			tokenCount += int(tokensByFileID[id])
		}
	}

	prediction, err := q.PredictProjectProcessTime(ctx, pgdb.PredictProjectProcessTimeParams{
		Duration: int64(tokenCount),
		StatType: statType,
	})
	if err != nil {
		prediction = 0
	}
	logger.Info("[Queue] Prediction for graph operation", "operation", data.Operation, "tokens", tokenCount, "time_ms", prediction)

	if data.CorrelationID != "" {
		_ = q.UpdateBatchEstimatedDuration(ctx, pgdb.UpdateBatchEstimatedDurationParams{
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
		return storageClient.DeleteStagedData(ctx, data.CorrelationID, data.BatchID, projectId)
	}

	for _, file := range *data.ProjectFiles {
		ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(file.FileKey)), ".")
		if ext != "xlsx" && ext != "xls" {
			continue
		}

		// Empty workbooks are valid: only enforce sheet artifacts for non-empty Excel files.
		tokens := tokensByFileID[file.ID]
		if tokens > 0 && excelSheetFileCounts[file.ID] == 0 {
			return fmt.Errorf("missing preprocessed Excel sheet text files for file %d", file.ID)
		}
	}

	if err := deleteStagedData(); err != nil {
		return fmt.Errorf("failed to cleanup staged data before extraction: %w", err)
	}

	if _, err := q.UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{
		ID:    projectId,
		State: projectState,
	}); err != nil {
		logger.Warn("[Queue] Failed to update project state at graph start", "project_id", projectId, "state", projectState, "err", err)
	}

	if data.CorrelationID != "" {
		_, err = q.TryStartGraphBatch(ctx, pgdb.TryStartGraphBatchParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				logger.Info("[Queue] Skipping graph batch: already claimed or not runnable", "project_id", data.ProjectID, "correlation_id", data.CorrelationID, "batch_id", data.BatchID)
				return nil
			}
			return err
		}
		graphBatchClaimed = true
	}

	graphID := fmt.Sprintf("%d", projectId)
	start := time.Now()

	logger.Debug("[Queue] Starting extraction phase", "project_id", projectId, "batch_id", data.BatchID)
	err = graphClient.ExtractAndStage(ctx, files, graphID, aiClient, storageClient, data.CorrelationID, data.BatchID)
	if err != nil {
		if cleanupErr := deleteStagedData(); cleanupErr != nil {
			logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
		}
		return err
	}

	if data.CorrelationID != "" {
		err = q.UpdateBatchStatus(ctx, pgdb.UpdateBatchStatusParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
			Column3:       "indexing",
		})
		if err != nil {
			return err
		}
	}

	_, err = q.UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{
		ID:    projectId,
		State: projectState,
	})
	if err != nil {
		if cleanupErr := deleteStagedData(); cleanupErr != nil {
			logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
		}
		return err
	}

	logger.Debug("[Queue] Acquiring project mutex for merge", "project_id", projectId)
	lockClient := leaselock.New(conn)
	lease, err := lockClient.Acquire(ctx, fmt.Sprintf("project:%d", projectId), leaselock.Options{
		TTL:         10 * time.Minute,
		RenewEvery:  4 * time.Minute,
		Wait:        true,
		TokenPrefix: fmt.Sprintf("graph-merge/%d/", projectId),
	})
	if err != nil {
		if cleanupErr := deleteStagedData(); cleanupErr != nil {
			logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
		}
		return err
	}
	releaseLease := func() error {
		if lease == nil {
			return nil
		}
		if err := lease.Release(context.Background()); err != nil {
			return err
		}
		lease = nil
		return nil
	}
	defer func() {
		if err := releaseLease(); err != nil {
			logger.Warn("[Queue] Failed to release project mutex", "project_id", projectId, "err", err)
		}
	}()

	err = graphClient.MergeFromStaging(lease.Context, files, graphID, aiClient, storageClient, data.CorrelationID, data.BatchID)
	if err != nil {
		if cleanupErr := deleteStagedData(); cleanupErr != nil {
			logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
		}
		return err
	}

	if cleanupErr := deleteStagedData(); cleanupErr != nil {
		logger.Warn("[Queue] Failed to delete staged data", "correlation_id", data.CorrelationID, "batch_id", data.BatchID, "err", cleanupErr)
	}

	duration := time.Since(start)
	if err := q.AddProcessTime(ctx, pgdb.AddProcessTimeParams{
		ProjectID: projectId,
		Amount:    int32(tokenCount),
		Duration:  duration.Milliseconds(),
		StatType:  statType,
	}); err != nil {
		return err
	}

	if data.CorrelationID != "" {
		err = q.UpdateBatchStatus(ctx, pgdb.UpdateBatchStatusParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
			Column3:       "completed",
		})
		if err != nil {
			return err
		}

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
					if _, err := q.UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{ID: projectId, State: "ready"}); err != nil {
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
		if err := releaseLease(); err != nil {
			logger.Error("[Queue] Failed to release project mutex before description updates", "project_id", projectId, "err", err)
			return err
		}
		if err := storageClient.UpdateEntityDescriptions(ctx, fileIDs); err != nil {
			logger.Error("[Queue] Failed to update entity descriptions", "project_id", projectId, "err", err)
		}
		if err := storageClient.UpdateRelationshipDescriptions(ctx, fileIDs); err != nil {
			logger.Error("[Queue] Failed to update relationship descriptions", "project_id", projectId, "err", err)
		}
		if _, err := q.UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{ID: projectId, State: "ready"}); err != nil {
			logger.Error("[Queue] Failed to set project state to ready", "project_id", projectId, "err", err)
		}
	}

	return nil
}
