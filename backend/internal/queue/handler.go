package queue

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphstorage "github.com/OFFIS-RIT/kiwi/backend/pkg/store/base"

	"github.com/aws/aws-sdk-go-v2/aws"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pkoukk/tiktoken-go"
	"github.com/rabbitmq/amqp091-go"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/graph"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/audio"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/csv"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/doc"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/excel"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/image"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/ocr"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/pdf"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/pptx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/s3"
)

type QueueProjectFileMsg struct {
	Message       string            `json:"message"`
	ProjectID     int64             `json:"project_id"`
	CorrelationID string            `json:"correlation_id,omitempty"`
	BatchID       int               `json:"batch_id,omitempty"`
	TotalBatches  int               `json:"total_batches,omitempty"`
	ProjectFiles  *[]db.ProjectFile `json:"project_files,omitempty"`
	Operation     string            `json:"operation,omitempty"` // "index" or "update"
}

type graphDBConn interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

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
			logger.Error("[Queue] Failed to release project lock", "project_id", projectId, "err", unlockErr)
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
			err := FinalizeDescriptionsForCorrelationWithLock(ctx, conn, aiClient, data.CorrelationID)
			if err != nil {
				logger.Error("[Queue] Failed to generate descriptions for correlation", "correlation_id", data.CorrelationID, "err", err)
			}

			latestCorrelationID, latestErr := q.GetLatestCorrelationForProject(ctx, projectId)
			if latestErr != nil {
				logger.Warn("[Queue] Failed to fetch latest correlation for project", "project_id", projectId, "correlation_id", data.CorrelationID, "err", latestErr)
			} else if latestCorrelationID == data.CorrelationID {
				if _, err := q.UpdateProjectState(ctx, db.UpdateProjectStateParams{ID: projectId, State: "ready"}); err != nil {
					logger.Error("[Queue] Failed to set project state to ready", "project_id", projectId, "correlation_id", data.CorrelationID, "err", err)
				}
			}
		}
	} else {
		if _, err := q.UpdateProjectState(ctx, db.UpdateProjectStateParams{ID: projectId, State: "ready"}); err != nil {
			logger.Error("[Queue] Failed to set project state to ready", "project_id", projectId, "err", err)
		}
	}

	return nil
}

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
			logger.Error("[Queue] Failed to release project lock", "project_id", projectId, "err", unlockErr)
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

func ProcessPreprocess(
	ctx context.Context,
	s3Client *awss3.Client,
	aiClient ai.GraphAIClient,
	ch *amqp091.Channel,
	conn *pgxpool.Pool,
	msg string,
) error {
	var data QueueProjectFileMsg
	err := json.Unmarshal([]byte(msg), &data)
	if err != nil {
		return err
	}

	q := db.New(conn)

	projectState := "create"
	if data.Operation == "update" {
		projectState = "update"
	}
	if _, err := q.UpdateProjectState(ctx, db.UpdateProjectStateParams{ID: data.ProjectID, State: projectState}); err != nil {
		logger.Warn("[Queue] Failed to update project state at preprocess start", "project_id", data.ProjectID, "state", projectState, "err", err)
	}

	if data.CorrelationID != "" {
		_ = q.UpdateBatchStatus(ctx, db.UpdateBatchStatusParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
			Column3:       "preprocessing",
		})
	}

	files := make([]loader.GraphFile, 0)
	noProcessingFiles := make([]loader.GraphFile, 0)
	pageCount := 0
	s3Bucket := util.GetEnvString("AWS_BUCKET", "kiwi")
	for _, upload := range *data.ProjectFiles {
		metadataText := ""
		if upload.Metadata.Valid {
			metadataText = upload.Metadata.String
		}

		s3L := s3.NewS3GraphFileLoaderWithClient(s3Bucket, s3Client)
		ocrL := ocr.NewOCRGraphLoader(ocr.NewOCRGraphLoaderParams{
			AIClient: aiClient,
		})

		ext := filepath.Ext(upload.Name)
		ext = strings.ReplaceAll(ext, ".", "")
		ext = strings.ToLower(ext)

		switch ext {
		case "doc", "docx", "odt":
			docL := doc.NewDocOcrGraphLoader(s3L, ocrL)
			f := loader.NewGraphDocumentFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", upload.ID),
				FilePath:  upload.FileKey,
				MaxTokens: 500,
				Loader:    docL,
				Metadata:  metadataText,
			})
			files = append(files, f)

			content, err := s3L.GetFileText(ctx, f)
			if err != nil {
				return err
			}

			pdfBytes, err := loader.TransformDocToPdf(content, ext)
			if err != nil {
				return err
			}
			pages, err := loader.CountPDFPages(pdfBytes)
			if err != nil {
				return err
			}
			pageCount += pages
		case "pptx":
			pptxL := pptx.NewPPTXOcrGraphLoader(s3L, ocrL)
			f := loader.NewGraphDocumentFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", upload.ID),
				FilePath:  upload.FileKey,
				MaxTokens: 500,
				Loader:    pptxL,
				Metadata:  metadataText,
			})
			files = append(files, f)

			content, err := s3L.GetFileText(ctx, f)
			if err != nil {
				return err
			}

			pdfBytes, err := loader.TransformDocToPdf(content, ext)
			if err != nil {
				return err
			}
			pages, err := loader.CountPDFPages(pdfBytes)
			if err != nil {
				return err
			}
			pageCount += pages
		case "pdf":
			ocrL := ocr.NewOCRGraphLoader(ocr.NewOCRGraphLoaderParams{
				Loader:   nil,
				AIClient: aiClient,
			})
			pdfL := pdf.NewPDFOcrGraphLoader(s3L, ocrL)
			f := loader.NewGraphDocumentFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", upload.ID),
				FilePath:  upload.FileKey,
				MaxTokens: 500,
				Loader:    pdfL,
				Metadata:  metadataText,
			})
			files = append(files, f)

			content, err := s3L.GetFileText(ctx, f)
			if err != nil {
				return err
			}

			pages, err := loader.CountPDFPages(content)
			if err != nil {
				return err
			}
			pageCount += pages
		case "jpg", "jpeg", "png", "bmp", "gif", "tiff", "heic", "webp":
			imgL := image.NewImageGraphLoader(image.NewImageGraphLoaderParams{
				AIClient: aiClient,
				Loader:   s3L,
			})
			f := loader.NewGraphImageFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", upload.ID),
				FilePath:  upload.FileKey,
				MaxTokens: 500,
				Loader:    imgL,
				Metadata:  metadataText,
			})
			files = append(files, f)
			pageCount += 1
		case "mp3", "wav", "mpeg", "mpga", "m4a", "ogg", "webm":
			audioL := audio.NewAudioGraphLoader(audio.NewAudioGraphLoaderParams{
				AIClient: aiClient,
				Loader:   s3L,
			})
			f := loader.NewGraphAudioFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", upload.ID),
				FilePath:  upload.FileKey,
				MaxTokens: 500,
				Loader:    audioL,
				Metadata:  metadataText,
			})
			files = append(files, f)

			head, err := s3Client.HeadObject(ctx, &awss3.HeadObjectInput{
				Bucket: aws.String(util.GetEnv("AWS_BUCKET")),
				Key:    aws.String(upload.FileKey),
			})
			if err == nil && head.ContentLength != nil {
				sizeMB := *head.ContentLength / (1024 * 1024)
				if sizeMB < 1 {
					pageCount += 1
				} else {
					pageCount += int(sizeMB)
				}
			} else {
				pageCount += 1
			}
		case "csv":
			csvL := csv.NewCSVGraphLoader(s3L)
			f := loader.NewGraphCSVFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", upload.ID),
				FilePath:  upload.FileKey,
				MaxTokens: 500,
				Loader:    csvL,
				Metadata:  metadataText,
			})
			files = append(files, f)

			head, err := s3Client.HeadObject(ctx, &awss3.HeadObjectInput{
				Bucket: aws.String(util.GetEnv("AWS_BUCKET")),
				Key:    aws.String(upload.FileKey),
			})
			if err == nil && head.ContentLength != nil {
				sizeKB := *head.ContentLength / 1024
				pages := max(int(sizeKB/50), 1)
				pageCount += pages
			} else {
				pageCount += 1
			}
		case "xlsx", "xls":
			excelL := excel.NewExcelGraphLoader(s3L)

			tempFile := loader.NewGraphDocumentFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", upload.ID),
				FilePath:  upload.FileKey,
				MaxTokens: 500,
				Loader:    s3L,
				Metadata:  metadataText,
			})
			content, err := s3L.GetFileText(ctx, tempFile)
			if err != nil {
				return err
			}

			csvSheets, err := loader.TransformExcelToCsv(content, ext)
			if err != nil {
				return err
			}

			sheetIndex := 0
			for sheetName, csvContent := range csvSheets {
				parsed, parseErr := csv.ParseCSV(csvContent)
				if parseErr != nil {
					continue
				}
				if len(parsed) == 0 {
					continue
				}

				sheetID := fmt.Sprintf("%d-sheet-%d", upload.ID, sheetIndex)
				baseName := strings.TrimSuffix(filepath.Base(upload.FileKey), filepath.Ext(upload.FileKey))
				sheetFilePath := fmt.Sprintf("%s/%s_%s%s",
					filepath.Dir(upload.FileKey),
					baseName,
					sheetName,
					filepath.Ext(upload.FileKey))

				f := loader.NewGraphCSVFile(loader.NewGraphFileParams{
					ID:        sheetID,
					FilePath:  sheetFilePath,
					MaxTokens: 500,
					Loader:    excelL,
					Metadata:  metadataText,
				})
				files = append(files, f)
				sheetIndex++

				sizeKB := len(parsed) / 1024
				pages := max(sizeKB/2, 1)
				pageCount += pages
			}
		case "txt", "md":
			f := loader.NewGraphDocumentFile(loader.NewGraphFileParams{
				ID:        fmt.Sprintf("%d", upload.ID),
				FilePath:  upload.FileKey,
				MaxTokens: 500,
				Loader:    s3L,
				Metadata:  metadataText,
			})
			files = append(files, f)

			head, err := s3Client.HeadObject(ctx, &awss3.HeadObjectInput{
				Bucket: aws.String(util.GetEnv("AWS_BUCKET")),
				Key:    aws.String(upload.FileKey),
			})
			if err == nil && head.ContentLength != nil {
				sizeKB := *head.ContentLength / 1024
				pages := max(int(sizeKB/50), 1)
				pageCount += pages
			} else {
				pageCount += 1
			}
		default:
			f := loader.NewGraphGenericFile(
				loader.NewGraphFileParams{
					ID:        fmt.Sprintf("%d", upload.ID),
					FilePath:  upload.FileKey,
					MaxTokens: 500,
					Loader:    s3L,
				},
				upload.Name,
			)
			noProcessingFiles = append(noProcessingFiles, f)
		}
	}

	prediction, err := q.PredictProjectProcessTime(ctx, db.PredictProjectProcessTimeParams{
		Duration: int64(pageCount),
		StatType: "file_processing",
	})
	if err != nil {
		prediction = 0
	}
	logger.Info("[Queue] Prediction for preprocessing", "batch_id", data.BatchID, "pages", pageCount, "time_ms", prediction)

	if data.CorrelationID != "" {
		_ = q.UpdateBatchEstimatedDuration(ctx, db.UpdateBatchEstimatedDurationParams{
			CorrelationID:     data.CorrelationID,
			BatchID:           int32(data.BatchID),
			EstimatedDuration: prediction,
		})
	}

	enc, err := tiktoken.GetEncoding("o200k_base")
	if err != nil {
		return err
	}

	type fileTokenCount struct {
		fileID     int64
		tokenCount int32
		metadata   string
		isGeneric  bool
	}
	tokenCounts := make([]fileTokenCount, 0)

	start := time.Now()
	for _, f := range files {
		txt, err := f.GetText(ctx)
		if err != nil {
			return fmt.Errorf("get text for file %s: %w", f.ID, err)
		}

		textContent := string(txt)

		fileID := f.ID
		if idx := strings.Index(fileID, "-sheet-"); idx != -1 {
			fileID = fileID[:idx]
		}
		id, err := strconv.ParseInt(fileID, 10, 64)
		if err != nil {
			return err
		}

		var fileName string
		for _, upload := range *data.ProjectFiles {
			if fmt.Sprintf("%d", upload.ID) == fileID {
				fileName = upload.Name
				break
			}
		}

		metadata, err := ai.ExtractDocumentMetadata(ctx, aiClient, fileName, textContent)
		if err != nil {
			return fmt.Errorf("extract metadata for file %s: %w", f.ID, err)
		}

		cleanText := ai.StripMetadataTags(textContent)

		tokens := enc.Encode(cleanText, nil, nil)
		count := len(tokens)

		tokenCounts = append(tokenCounts, fileTokenCount{fileID: id, tokenCount: int32(count), metadata: metadata, isGeneric: false})

		key := filepath.Base(f.FilePath)
		path := filepath.Dir(f.FilePath)
		ext := filepath.Ext(key)
		nameWithoutExt := strings.TrimSuffix(key, ext)
		name := nameWithoutExt + ".txt"

		content := bytes.NewReader([]byte(cleanText))
		_, err = storage.PutFile(ctx, s3Client, path, name, nameWithoutExt, content)
		if err != nil {
			return fmt.Errorf("put file %s: %w", f.ID, err)
		}
	}
	duration := time.Since(start)

	for _, f := range noProcessingFiles {
		content, err := f.GetText(ctx)
		if err != nil {
			return fmt.Errorf("get text for file %s: %w", f.ID, err)
		}

		textContent := string(content)

		id, err := strconv.ParseInt(f.ID, 10, 64)
		if err != nil {
			return err
		}

		tokens := enc.Encode(textContent, nil, nil)
		count := len(tokens)
		tokenCounts = append(tokenCounts, fileTokenCount{fileID: id, tokenCount: int32(count), metadata: "", isGeneric: true})

		if strings.TrimSpace(textContent) == "" {
			continue
		}

		key := filepath.Base(f.FilePath)
		path := filepath.Dir(f.FilePath)
		ext := filepath.Ext(key)
		nameWithoutExt := strings.TrimSuffix(key, ext)
		name := nameWithoutExt + ".txt"

		contentReader := bytes.NewReader([]byte(textContent))
		_, err = storage.PutFile(ctx, s3Client, path, name, nameWithoutExt, contentReader)
		if err != nil {
			return fmt.Errorf("put file %s: %w", f.ID, err)
		}
	}

	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	qtx := q.WithTx(tx)

	for _, tc := range tokenCounts {
		err = qtx.AddTokenCountToFile(ctx, db.AddTokenCountToFileParams{
			ID:         tc.fileID,
			TokenCount: tc.tokenCount,
		})
		if err != nil {
			return fmt.Errorf("add token count for file %d: %w", tc.fileID, err)
		}

		if tc.isGeneric {
			continue
		}

		err = qtx.UpdateProjectFileMetadata(ctx, db.UpdateProjectFileMetadataParams{
			ID:       tc.fileID,
			Metadata: pgtype.Text{String: tc.metadata, Valid: true},
		})
		if err != nil {
			return fmt.Errorf("update metadata for file %d: %w", tc.fileID, err)
		}
	}

	err = qtx.AddProcessTime(ctx, db.AddProcessTimeParams{
		ProjectID: data.ProjectID,
		Amount:    int32(pageCount),
		Duration:  duration.Milliseconds(),
		StatType:  "file_processing",
	})
	if err != nil {
		return fmt.Errorf("add process time: %w", err)
	}

	err = tx.Commit(ctx)
	if err != nil {
		return err
	}

	if data.CorrelationID != "" {
		_ = q.UpdateBatchStatus(ctx, db.UpdateBatchStatusParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
			Column3:       "preprocessed",
		})
	}

	err = PublishFIFO(ch, "graph_queue", []byte(msg))
	if err != nil {
		return err
	}

	return nil
}

func RecoverStaleBatches(
	ctx context.Context,
	ch *amqp091.Channel,
	conn *pgxpool.Pool,
) error {
	q := db.New(conn)

	const recoveryLockID = 1
	acquired, err := q.TryAcquireProjectLock(ctx, recoveryLockID)
	if err != nil {
		return fmt.Errorf("failed to try acquire recovery lock: %w", err)
	}
	if !acquired {
		logger.Debug("[Queue] Another worker running stale batch recovery, skipping")
		return nil
	}
	defer func() {
		if unlockErr := q.ReleaseProjectLock(ctx, recoveryLockID); unlockErr != nil {
			logger.Error("[Queue] Failed to release recovery lock", "err", unlockErr)
		}
	}()

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
	if err := json.Unmarshal(msgBody, &data); err != nil {
		return
	}

	if data.CorrelationID == "" {
		return
	}

	q := db.New(conn)

	switch queueName {
	case "preprocess_queue":
		_ = q.ResetBatchToPending(ctx, db.ResetBatchToPendingParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
		})
	case "graph_queue":
		_ = q.ResetBatchToPreprocessed(ctx, db.ResetBatchToPreprocessedParams{
			CorrelationID: data.CorrelationID,
			BatchID:       int32(data.BatchID),
		})
	}
}

// FinalizeDescriptionsForCorrelation generates descriptions for all entities/relationships
// that have new sources from the batches in the given correlation ID.
func FinalizeDescriptionsForCorrelation(
	ctx context.Context,
	conn graphDBConn,
	aiClient ai.GraphAIClient,
	correlationID string,
) error {
	q := db.New(conn)

	batches, err := q.GetBatchesByCorrelation(ctx, correlationID)
	if err != nil {
		return fmt.Errorf("failed to get batches: %w", err)
	}

	fileIDSet := make(map[int64]struct{})
	for _, batch := range batches {
		for _, fid := range batch.FileIds {
			fileIDSet[fid] = struct{}{}
		}
	}

	if len(fileIDSet) == 0 {
		logger.Debug("[Queue] No files to generate descriptions for", "correlation_id", correlationID)
		return nil
	}

	fileIDs := make([]int64, 0, len(fileIDSet))
	for fid := range fileIDSet {
		fileIDs = append(fileIDs, fid)
	}

	files := make([]loader.GraphFile, 0, len(fileIDs))
	for _, fid := range fileIDs {
		files = append(files, loader.GraphFile{ID: fmt.Sprintf("%d", fid)})
	}

	logger.Info("[Queue] Starting description generation with retry", "correlation_id", correlationID, "file_count", len(files))

	storageClient, err := graphstorage.NewGraphDBStorageWithConnection(ctx, conn, aiClient, []string{})
	if err != nil {
		return fmt.Errorf("failed to create storage client: %w", err)
	}

	err = util.RetryErrWithContext(ctx, 3, func(ctx context.Context) error {
		return storageClient.GenerateDescriptions(ctx, files)
	})

	if err != nil {
		return fmt.Errorf("failed to generate descriptions after retries: %w", err)
	}

	return nil
}

func FinalizeDescriptionsForCorrelationWithLock(
	ctx context.Context,
	conn *pgxpool.Pool,
	aiClient ai.GraphAIClient,
	correlationID string,
) error {
	lockConn, err := conn.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("failed to acquire lock connection: %w", err)
	}
	defer lockConn.Release()

	lockID := correlationLockID(correlationID)
	q := db.New(lockConn)
	acquired, err := q.TryAcquireProjectLock(ctx, lockID)
	if err != nil {
		return fmt.Errorf("failed to acquire description lock: %w", err)
	}
	if !acquired {
		logger.Debug("[Queue] Description generation already in progress", "correlation_id", correlationID)
		return nil
	}
	defer func() {
		if unlockErr := q.ReleaseProjectLock(ctx, lockID); unlockErr != nil {
			logger.Error("[Queue] Failed to release description lock", "correlation_id", correlationID, "err", unlockErr)
		}
	}()

	allDone, checkErr := q.AreAllBatchesCompleted(ctx, correlationID)
	if checkErr != nil {
		return fmt.Errorf("failed to re-check batch completion: %w", checkErr)
	}
	if !allDone {
		logger.Debug("[Queue] Batches no longer complete, skipping description generation", "correlation_id", correlationID)
		return nil
	}

	logger.Info("[Queue] All batches completed, starting description generation", "correlation_id", correlationID)

	err = FinalizeDescriptionsForCorrelation(ctx, lockConn, aiClient, correlationID)
	if err != nil {
		return err
	}

	logger.Info("[Queue] Description generation completed", "correlation_id", correlationID)
	return nil
}

func correlationLockID(correlationID string) int64 {
	hasher := fnv.New64a()
	_, _ = hasher.Write([]byte("correlation:" + correlationID))
	return int64(hasher.Sum64())
}
