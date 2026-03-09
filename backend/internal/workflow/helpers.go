package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/pkoukk/tiktoken-go"

	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/graph"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/leaselock"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/audio"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/csv"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/doc"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/excel"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/image"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/ocr"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/pdf"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/pptx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	workflowpkg "github.com/OFFIS-RIT/kiwi/backend/pkg/workflow"

	"github.com/jackc/pgx/v5"
)

const (
	batchStatusPending          = "pending"
	batchStatusPreprocessing    = "preprocessing"
	batchStatusMetadata         = "extracting_metadata"
	batchStatusChunking         = "chunking"
	batchStatusExtracting       = "extracting_graph"
	batchStatusDeduplicating    = "deduplicating"
	batchStatusSaving           = "saving"
	batchStatusDescribing       = "describing"
	batchStatusCompleted        = "completed"
	descriptionStatusPending    = "pending"
	descriptionStatusProcessing = "processing"
	descriptionStatusCompleted  = "completed"
	defaultChunkTokenEncoder    = "o200k_base"
	defaultGraphMaxChunkSize    = 1000
)

type preprocessOutput struct {
	TextKey     string `json:"text_key"`
	FileType    string `json:"file_type"`
	Description string `json:"description,omitempty"`
}

type chunkOutput struct {
	UnitsKey string `json:"units_key"`
}

type graphOutput struct {
	GraphKey string `json:"graph_key"`
}

type unitsArtifact struct {
	Units []*common.Unit `json:"units"`
}

type graphArtifact struct {
	Units         []*common.Unit        `json:"units"`
	Entities      []common.Entity       `json:"entities"`
	Relationships []common.Relationship `json:"relationships"`
}

type batchMetrics struct {
	FileType          string `json:"file_type"`
	TextBytes         int64  `json:"text_bytes"`
	TextChars         int64  `json:"text_chars"`
	EstimatedTokens   int64  `json:"estimated_tokens"`
	ChunkCount        int32  `json:"chunk_count"`
	PageCount         int32  `json:"page_count"`
	RowCount          int32  `json:"row_count"`
	AudioDurationMS   int64  `json:"audio_duration_ms"`
	NeedsOCR          bool   `json:"needs_ocr"`
	EntityCount       int32  `json:"entity_count"`
	RelationshipCount int32  `json:"relationship_count"`
}

type descriptionMetrics struct {
	SourceCount       int32 `json:"source_count"`
	EntityCount       int32 `json:"entity_count"`
	RelationshipCount int32 `json:"relationship_count"`
	BatchSize         int32 `json:"batch_size"`
}

type durationPrediction struct {
	PreprocessMS  int64 `json:"preprocess_ms"`
	MetadataMS    int64 `json:"metadata_ms"`
	ChunkMS       int64 `json:"chunk_ms"`
	ExtractMS     int64 `json:"extract_ms"`
	DedupeMS      int64 `json:"dedupe_ms"`
	SaveMS        int64 `json:"save_ms"`
	DescribeMS    int64 `json:"describe_ms"`
	TotalMS       int64 `json:"total_ms"`
	SampleCount   int32 `json:"sample_count"`
	FallbackLevel int32 `json:"fallback_level"`
}

type stepDurations struct {
	PreprocessMS int64
	MetadataMS   int64
	ChunkMS      int64
	ExtractMS    int64
	DedupeMS     int64
	SaveMS       int64
	DescribeMS   int64
	TotalMS      int64
}

func unmarshalInput[T any](raw []byte) (T, error) {
	var value T
	if len(raw) == 0 {
		return value, nil
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, err
	}
	return value, nil
}

func decodeValue[T any](value any) (T, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		var zero T
		return zero, err
	}
	return unmarshalInput[T](raw)
}

func (s *Service) artifactPrefix(projectID string, correlationID string, batchID int) string {
	return fmt.Sprintf("projects/%s/workflows/%s/%d", projectID, correlationID, batchID)
}

func workflowRunID(kind string, correlationID string, id int) string {
	return fmt.Sprintf("%s:%s:%d", kind, correlationID, id)
}

func (s *Service) putTextArtifact(ctx context.Context, prefix, name, key, value string) (string, error) {
	return storage.PutFile(ctx, s.s3, prefix, name, key, bytes.NewReader([]byte(value)))
}

func (s *Service) putTextArtifactAtKey(ctx context.Context, key string, value string) (string, error) {
	_, err := s.s3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(util.GetEnv("AWS_BUCKET")),
		Key:         aws.String(key),
		Body:        bytes.NewReader([]byte(value)),
		ContentType: aws.String("text/plain; charset=utf-8"),
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

func (s *Service) putJSONArtifact(ctx context.Context, prefix, name, key string, value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return storage.PutFile(ctx, s.s3, prefix, name, key, bytes.NewReader(raw))
}

func (s *Service) readTextArtifact(ctx context.Context, key string) (string, error) {
	raw, err := storage.GetFile(ctx, s.s3, key)
	if err != nil {
		return "", err
	}
	return string(*raw), nil
}

func readJSONArtifact[T any](ctx context.Context, s3Client *s3.Client, key string) (T, error) {
	var value T
	raw, err := storage.GetFile(ctx, s3Client, key)
	if err != nil {
		return value, err
	}
	if err := json.Unmarshal(*raw, &value); err != nil {
		return value, err
	}
	return value, nil
}

func (s *Service) deleteArtifact(ctx context.Context, key string) {
	if key == "" {
		return
	}
	_ = storage.DeleteFile(ctx, s.s3, key)
}

func preprocessedTextKey(fileKey string) string {
	ext := strings.ToLower(filepath.Ext(fileKey))
	if ext == ".txt" {
		return fileKey
	}
	if ext == "" {
		return fileKey + ".txt"
	}
	return strings.TrimSuffix(fileKey, filepath.Ext(fileKey)) + ".txt"
}

func (s *Service) buildGraphFile(input ProcessWorkflowInput) loader.GraphFile {
	filePath := input.FileKey
	baseLoader := s.s3Loader
	ext := strings.ToLower(filepath.Ext(input.FileName))
	params := loader.NewGraphFileParams{
		ID:       input.FileID,
		FilePath: filePath,
		Loader:   baseLoader,
	}

	ocrLoader := ocr.NewOCRGraphLoader(ocr.NewOCRGraphLoaderParams{
		Loader:   baseLoader,
		AIClient: s.aiClient,
	})

	switch ext {
	case ".pdf":
		params.Loader = pdf.NewPDFOcrGraphLoader(baseLoader, ocrLoader)
		return loader.NewGraphDocumentFile(params)
	case ".doc", ".docx", ".odt", ".rtf":
		params.Loader = doc.NewDocOcrGraphLoader(baseLoader, ocrLoader)
		return loader.NewGraphDocumentFile(params)
	case ".pptx":
		params.Loader = pptx.NewPPTXOcrGraphLoader(baseLoader, ocrLoader)
		return loader.NewGraphDocumentFile(params)
	case ".csv", ".tsv":
		params.Loader = csv.NewCSVGraphLoader(baseLoader)
		return loader.NewGraphCSVFile(params)
	case ".xls", ".xlsx":
		params.Loader = excel.NewExcelGraphLoader(baseLoader)
		return loader.NewGraphCSVFile(params)
	case ".json":
		return loader.NewGraphJSONFile(params)
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff":
		params.Loader = image.NewImageGraphLoader(image.NewImageGraphLoaderParams{
			AIClient: s.aiClient,
			Loader:   baseLoader,
		})
		return loader.NewGraphImageFile(params)
	case ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac":
		params.Loader = audio.NewAudioGraphLoader(audio.NewAudioGraphLoaderParams{
			AIClient: s.aiClient,
			Loader:   baseLoader,
		})
		return loader.NewGraphAudioFile(params)
	default:
		return loader.NewGraphDocumentFile(params)
	}
}

func fileTypeFromName(fileName string) loader.GraphFileType {
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".csv", ".tsv", ".xls", ".xlsx":
		return loader.GraphFileTypeCSV
	case ".json":
		return loader.GraphFileTypeJSON
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff":
		return loader.GraphFileTypeImage
	case ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac":
		return loader.GraphFileTypeAudio
	default:
		return loader.GraphFileTypeDocument
	}
}

func buildExtractFile(input ProcessWorkflowInput, output preprocessOutput, metadata string) graph.ExtractFile {
	return graph.ExtractFile{
		ID:          input.FileID,
		FilePath:    input.FileName,
		FileType:    loader.GraphFileType(output.FileType),
		Description: output.Description,
		Metadata:    metadata,
	}
}

func chunkConfig() (string, int) {
	return util.GetEnvString("AI_TOKEN_ENCODER", defaultChunkTokenEncoder), int(util.GetEnvNumeric("GRAPH_MAX_CHUNK_SIZE", defaultGraphMaxChunkSize))
}

func currentAIConfig() (string, string, string) {
	model := util.GetEnvString("AI_EXTRACT_MODEL", "")
	if model == "" {
		model = util.GetEnvString("AI_CHAT_MODEL", "")
	}
	return util.GetEnvString("AI_ADAPTER", "openai"), model, util.GetEnvString("AI_EMBED_MODEL", "")
}

func derivePreprocessMetrics(fileName string, fileType loader.GraphFileType, text string) batchMetrics {
	metrics := batchMetrics{
		FileType:        string(fileType),
		TextBytes:       int64(len(text)),
		TextChars:       int64(utf8.RuneCountInString(text)),
		EstimatedTokens: estimateTokens(text),
		NeedsOCR:        requiresOCR(fileName),
	}

	if fileType == loader.GraphFileTypeCSV {
		metrics.RowCount = int32(countDelimitedRows(text))
	}

	return metrics
}

func estimateTokens(text string) int64 {
	if strings.TrimSpace(text) == "" {
		return 0
	}

	encoderName, _ := chunkConfig()
	encoder, err := tiktoken.GetEncoding(encoderName)
	if err == nil {
		return int64(len(encoder.Encode(text, nil, nil)))
	}

	return int64(max(1, utf8.RuneCountInString(text)/4))
}

func requiresOCR(fileName string) bool {
	ext := strings.ToLower(filepath.Ext(fileName))
	switch ext {
	case ".pdf", ".doc", ".docx", ".odt", ".rtf", ".pptx", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff":
		return true
	default:
		return false
	}
}

func countDelimitedRows(text string) int {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0
	}
	return strings.Count(trimmed, "\n") + 1
}

func (s *Service) withProjectLock(ctx context.Context, projectID string, fn func(ctx context.Context) error) error {
	lockClient := leaselock.New(s.db)
	lockKey := fmt.Sprintf("workflow:project:%s:save", projectID)

	return lockClient.WithLease(ctx, lockKey, leaselock.Options{
		TTL:          2 * time.Minute,
		RenewEvery:   30 * time.Second,
		Wait:         true,
		WaitInterval: 250 * time.Millisecond,
		WaitJitter:   100 * time.Millisecond,
		TokenPrefix:  "workflow-save-",
	}, fn)
}

func (s *Service) withCorrelationLock(ctx context.Context, correlationID string, purpose string, fn func(ctx context.Context) error) error {
	lockClient := leaselock.New(s.db)
	lockKey := fmt.Sprintf("workflow:correlation:%s:%s", correlationID, purpose)

	return lockClient.WithLease(ctx, lockKey, leaselock.Options{
		TTL:          30 * time.Second,
		RenewEvery:   10 * time.Second,
		Wait:         true,
		WaitInterval: 100 * time.Millisecond,
		WaitJitter:   50 * time.Millisecond,
		TokenPrefix:  "workflow-correlation-",
	}, fn)
}

func appendLogAttrs(base []any, attrs ...any) []any {
	combined := make([]any, 0, len(base)+len(attrs))
	combined = append(combined, base...)
	combined = append(combined, attrs...)
	return combined
}

func runLoggedStep(ctx context.Context, step *workflowpkg.StepAPI, stepName string, attrs []any, fn func() (any, error)) (any, int64, error) {
	logger.Debug("Starting workflow step", appendLogAttrs(attrs, "step", stepName)...)
	startedAt := time.Now()

	result, durationMS, err := step.RunWithDuration(ctx, stepName, fn)
	if durationMS <= 0 {
		durationMS = time.Since(startedAt).Milliseconds()
	}
	finishAttrs := appendLogAttrs(attrs, "step", stepName, "duration_ms", durationMS)
	if err != nil {
		logger.Error("Workflow step failed", appendLogAttrs(finishAttrs, "err", err)...)
		logger.Debug("Finished workflow step", appendLogAttrs(finishAttrs, "status", "failed")...)
		return nil, durationMS, err
	}

	logger.Debug("Finished workflow step", appendLogAttrs(finishAttrs, "status", "completed")...)
	return result, durationMS, nil
}

func logWorkflowStarted(name string, attrs []any) time.Time {
	logger.Info("Starting workflow", appendLogAttrs(attrs, "workflow", name)...)
	return time.Now()
}

func logWorkflowFinished(name string, startedAt time.Time, workflowErr error, attrs []any) {
	finishAttrs := appendLogAttrs(attrs, "workflow", name, "duration_ms", time.Since(startedAt).Milliseconds())
	if workflowErr != nil {
		logger.Error("Workflow failed", appendLogAttrs(finishAttrs, "err", workflowErr)...)
		logger.Info("Finished workflow", appendLogAttrs(finishAttrs, "status", "failed")...)
		return
	}

	logger.Info("Finished workflow", appendLogAttrs(finishAttrs, "status", "completed")...)
}

func processWorkflowLogAttrs(payload ProcessWorkflowInput) []any {
	return []any{
		"project_id", payload.ProjectID,
		"file_id", payload.FileID,
		"file_name", payload.FileName,
		"correlation_id", payload.CorrelationID,
		"batch_id", payload.BatchID,
		"total_batches", payload.TotalBatches,
		"operation", payload.Operation,
	}
}

func deleteWorkflowLogAttrs(payload DeleteWorkflowInput) []any {
	return []any{
		"project_id", payload.ProjectID,
		"file_id", payload.FileID,
		"file_name", payload.FileName,
		"correlation_id", payload.CorrelationID,
		"batch_id", payload.BatchID,
		"total_batches", payload.TotalBatches,
	}
}

func descriptionWorkflowLogAttrs(payload DescriptionWorkflowInput) []any {
	return []any{
		"project_id", payload.ProjectID,
		"correlation_id", payload.CorrelationID,
		"job_id", payload.JobID,
		"total_jobs", payload.TotalJobs,
		"batch_size", payload.BatchSize,
		"entity_count", payload.EntityCount,
		"relationship_count", payload.RelationshipCount,
		"source_count", payload.SourceCount,
	}
}

func marshalJSONValue(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		logger.Error("Failed to marshal workflow JSON value", "err", err)
		return []byte("{}")
	}
	return raw
}

func loadWorkflowStatMetrics[T any](ctx context.Context, db pgdb.DBTX, runID string) (T, error) {
	var zero T
	if runID == "" {
		return zero, nil
	}
	stat, err := pgdb.New(db).GetWorkflowStatByRunID(ctx, nullText(runID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return zero, nil
		}
		return zero, err
	}
	if len(stat.Metrics) == 0 {
		return zero, nil
	}
	return unmarshalInput[T](stat.Metrics)
}

func (s *Service) isLatestCorrelation(ctx context.Context, projectID string, correlationID string) (bool, error) {
	q := pgdb.New(s.db)
	latestCorrelationID, err := q.GetLatestCorrelationForProject(ctx, projectID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return latestCorrelationID == correlationID, nil
}

func (s *Service) markProjectReadyIfLatestCorrelation(ctx context.Context, projectID string, correlationID string) error {
	isLatest, err := s.isLatestCorrelation(ctx, projectID, correlationID)
	if err != nil {
		return err
	}
	if !isLatest {
		return nil
	}
	_, err = pgdb.New(s.db).UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{ID: projectID, State: "ready"})
	return err
}

func (s *Service) createWorkflowStat(ctx context.Context, q *pgdb.Queries, params pgdb.CreateWorkflowStatParams) error {
	_, err := q.CreateWorkflowStat(ctx, params)
	return err
}

func (s *Service) updateWorkflowStatStep(ctx context.Context, runID string, status string, stepName string) error {
	return pgdb.New(s.db).UpdateWorkflowStatStep(ctx, pgdb.UpdateWorkflowStatStepParams{
		RunID:       nullText(runID),
		Status:      status,
		CurrentStep: stepName,
	})
}

func (s *Service) updateWorkflowStatMetrics(ctx context.Context, runID string, metrics any) error {
	return pgdb.New(s.db).UpdateWorkflowStatMetrics(ctx, pgdb.UpdateWorkflowStatMetricsParams{
		RunID:   nullText(runID),
		Column2: marshalJSONValue(metrics),
	})
}

func (s *Service) persistWorkflowStatPrediction(ctx context.Context, runID string, prediction durationPrediction) error {
	return pgdb.New(s.db).UpdateWorkflowStatPrediction(ctx, pgdb.UpdateWorkflowStatPredictionParams{
		RunID:                   nullText(runID),
		EstimatedDuration:       prediction.TotalMS,
		PredictionSampleCount:   prediction.SampleCount,
		PredictionFallbackLevel: prediction.FallbackLevel,
		Column5:                 marshalJSONValue(prediction),
	})
}

func (s *Service) completeWorkflowStat(ctx context.Context, runID string, status string) error {
	return pgdb.New(s.db).CompleteWorkflowStat(ctx, pgdb.CompleteWorkflowStatParams{
		RunID:  nullText(runID),
		Status: status,
	})
}

func (s *Service) failWorkflowStat(ctx context.Context, runID string, message string) error {
	return pgdb.New(s.db).FailWorkflowStat(ctx, pgdb.FailWorkflowStatParams{
		RunID:        nullText(runID),
		ErrorMessage: message,
	})
}
