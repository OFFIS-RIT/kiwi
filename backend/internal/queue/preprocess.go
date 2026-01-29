package queue

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/aws/aws-sdk-go-v2/aws"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pkoukk/tiktoken-go"
	"github.com/rabbitmq/amqp091-go"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
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

	q := pgdb.New(conn)

	projectState := "create"
	if data.Operation == "update" {
		projectState = "update"
	}
	if _, err := q.UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{ID: data.ProjectID, State: projectState}); err != nil {
		logger.Warn("[Queue] Failed to update project state at preprocess start", "project_id", data.ProjectID, "state", projectState, "err", err)
	}

	if data.CorrelationID != "" {
		_ = q.UpdateBatchStatus(ctx, pgdb.UpdateBatchStatusParams{
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

	prediction, err := q.PredictProjectProcessTime(ctx, pgdb.PredictProjectProcessTimeParams{
		Duration: int64(pageCount),
		StatType: "file_processing",
	})
	if err != nil {
		prediction = 0
	}
	logger.Info("[Queue] Prediction for preprocessing", "batch_id", data.BatchID, "pages", pageCount, "time_ms", prediction)

	if data.CorrelationID != "" {
		_ = q.UpdateBatchEstimatedDuration(ctx, pgdb.UpdateBatchEstimatedDurationParams{
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
		err = qtx.AddTokenCountToFile(ctx, pgdb.AddTokenCountToFileParams{
			ID:         tc.fileID,
			TokenCount: tc.tokenCount,
		})
		if err != nil {
			return fmt.Errorf("add token count for file %d: %w", tc.fileID, err)
		}

		if tc.isGeneric {
			continue
		}

		err = qtx.UpdateProjectFileMetadata(ctx, pgdb.UpdateProjectFileMetadataParams{
			ID:       tc.fileID,
			Metadata: pgtype.Text{String: tc.metadata, Valid: true},
		})
		if err != nil {
			return fmt.Errorf("update metadata for file %d: %w", tc.fileID, err)
		}
	}

	err = qtx.AddProcessTime(ctx, pgdb.AddProcessTimeParams{
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
		_ = q.UpdateBatchStatus(ctx, pgdb.UpdateBatchStatusParams{
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
