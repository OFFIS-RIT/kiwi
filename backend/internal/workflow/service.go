package workflow

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/graph"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	loaders3 "github.com/OFFIS-RIT/kiwi/backend/pkg/loader/s3"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	storepgx "github.com/OFFIS-RIT/kiwi/backend/pkg/store/pgx"
	workflowpkg "github.com/OFFIS-RIT/kiwi/backend/pkg/workflow"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	db                  *pgxpool.Pool
	s3                  *s3.Client
	aiClient            ai.GraphAIClient
	graphClient         *graph.GraphClient
	s3Loader            *loaders3.S3GraphFileLoader
	workflowClient      *workflowpkg.Client
	processWorkflow     workflowpkg.Workflow
	deleteWorkflow      workflowpkg.Workflow
	descriptionWorkflow workflowpkg.Workflow
}

func NewService(ctx context.Context, db *pgxpool.Pool, s3Client *s3.Client, aiClient ai.GraphAIClient) (*Service, error) {
	graphClient, err := graph.NewGraphClient(graph.NewGraphClientParams{
		TokenEncoder:  util.GetEnvString("AI_TOKEN_ENCODER", "o200k_base"),
		ParallelFiles: int(util.GetEnvNumeric("GRAPH_PARALLEL_FILES", 4)),
		MaxRetries:    int(util.GetEnvNumeric("GRAPH_MAX_RETRIES", 3)),
	})
	if err != nil {
		return nil, fmt.Errorf("create graph client: %w", err)
	}

	workflowStorage, err := storepgx.NewWorkflowDBStorageWithConnection(ctx, db)
	if err != nil {
		return nil, fmt.Errorf("create workflow storage: %w", err)
	}

	workflowClient, err := workflowpkg.NewClient(workflowpkg.WithStorage(workflowStorage))
	if err != nil {
		return nil, fmt.Errorf("create workflow client: %w", err)
	}

	service := &Service{
		db:             db,
		s3:             s3Client,
		aiClient:       aiClient,
		graphClient:    graphClient,
		s3Loader:       loaders3.NewS3GraphFileLoaderWithClient(util.GetEnv("AWS_BUCKET"), s3Client),
		workflowClient: workflowClient,
	}

	service.processWorkflow = service.newProcessWorkflow()
	service.deleteWorkflow = service.newDeleteWorkflow()
	service.descriptionWorkflow = service.newDescriptionWorkflow()

	for _, implementation := range []workflowpkg.Workflow{
		service.processWorkflow,
		service.deleteWorkflow,
		service.descriptionWorkflow,
	} {
		if err := service.workflowClient.ImplementWorkflow(implementation); err != nil {
			return nil, fmt.Errorf("register workflow %s: %w", implementation.Spec.Name, err)
		}
	}

	return service, nil
}

func (s *Service) Start(ctx context.Context) error {
	concurrency := int(util.GetEnvNumeric("WORKFLOW_WORKER_CONCURRENCY", 1))
	worker := s.workflowClient.NewWorker(
		workflowpkg.WithConcurrency(concurrency),
		workflowpkg.WithPollInterval(time.Second),
		workflowpkg.WithTerminalFailureHandler(s.handleTerminalFailure),
	)

	logger.Info("Starting workflow worker", "poll_interval", time.Second, "concurrency", concurrency)
	return worker.Start(ctx)
}

func (s *Service) EnqueueProcessFiles(ctx context.Context, tx pgx.Tx, projectID string, files []pgdb.ProjectFile, operation string) (string, error) {
	if len(files) == 0 {
		return "", nil
	}

	qtx := pgdb.New(tx)
	state := "update"
	if operation == "index" {
		state = "create"
	}
	if _, err := qtx.UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{ID: projectID, State: state}); err != nil {
		return "", fmt.Errorf("update project state: %w", err)
	}

	correlationID := ids.New()

	runClient, err := s.newRunClient(ctx, tx)
	if err != nil {
		return "", err
	}

	totalBatches := len(files)
	for idx, file := range files {
		runID := workflowRunID("process", correlationID, idx)
		initialMetrics := batchMetrics{
			FileType: string(fileTypeFromName(file.Name)),
			NeedsOCR: requiresOCR(file.Name),
		}
		initialPrediction := s.predictProcessDurations(ctx, operation, initialMetrics)
		handle, err := runClient.RunWorkflow(ctx, s.processWorkflow, ProcessWorkflowInput{
			RunID:         runID,
			ProjectID:     projectID,
			FileID:        file.ID,
			FileName:      file.Name,
			FileKey:       file.FileKey,
			CorrelationID: correlationID,
			BatchID:       idx,
			TotalBatches:  totalBatches,
			Operation:     operation,
		}, workflowpkg.WithRunID(runID), workflowpkg.WithIdempotencyKey(fmt.Sprintf("process:%s:%d", correlationID, idx)))
		if err != nil {
			return "", fmt.Errorf("enqueue process workflow for file %s: %w", file.ID, err)
		}
		if err := s.createWorkflowStat(ctx, qtx, pgdb.CreateWorkflowStatParams{
			ID:                      ids.New(),
			RunID:                   nullText(handle.ID()),
			ProjectID:               projectID,
			CorrelationID:           correlationID,
			WorkflowName:            s.processWorkflow.Spec.Name,
			WorkflowVersion:         s.processWorkflow.Spec.Version,
			SubjectType:             "file",
			SubjectID:               file.ID,
			FileID:                  pgtype.Text{String: file.ID, Valid: true},
			Operation:               operation,
			Status:                  batchStatusPending,
			CurrentStep:             "",
			EstimatedDuration:       initialPrediction.TotalMS,
			PredictionSampleCount:   initialPrediction.SampleCount,
			PredictionFallbackLevel: initialPrediction.FallbackLevel,
			Metrics:                 marshalJSONValue(initialMetrics),
			Prediction:              marshalJSONValue(initialPrediction),
			ErrorMessage:            "",
		}); err != nil {
			return "", fmt.Errorf("create workflow stat for file %s: %w", file.ID, err)
		}
	}

	return correlationID, nil
}

func (s *Service) EnqueueDeleteFiles(ctx context.Context, tx pgx.Tx, projectID string, files []pgdb.ProjectFile) (string, error) {
	if len(files) == 0 {
		return "", nil
	}

	qtx := pgdb.New(tx)
	if _, err := qtx.UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{ID: projectID, State: "update"}); err != nil {
		return "", fmt.Errorf("update project state: %w", err)
	}

	correlationID := ids.New()

	runClient, err := s.newRunClient(ctx, tx)
	if err != nil {
		return "", err
	}

	totalBatches := len(files)
	for idx, file := range files {
		runID := workflowRunID("delete", correlationID, idx)
		initialMetrics := batchMetrics{
			FileType: string(fileTypeFromName(file.Name)),
			NeedsOCR: requiresOCR(file.Name),
		}
		initialPrediction := s.predictDeleteDurations(ctx, initialMetrics)
		handle, err := runClient.RunWorkflow(ctx, s.deleteWorkflow, DeleteWorkflowInput{
			RunID:         runID,
			ProjectID:     projectID,
			FileID:        file.ID,
			FileName:      file.Name,
			FileKey:       file.FileKey,
			CorrelationID: correlationID,
			BatchID:       idx,
			TotalBatches:  totalBatches,
		}, workflowpkg.WithRunID(runID), workflowpkg.WithIdempotencyKey(fmt.Sprintf("delete:%s:%d", correlationID, idx)))
		if err != nil {
			return "", fmt.Errorf("enqueue delete workflow for file %s: %w", file.ID, err)
		}
		if err := s.createWorkflowStat(ctx, qtx, pgdb.CreateWorkflowStatParams{
			ID:                      ids.New(),
			RunID:                   nullText(handle.ID()),
			ProjectID:               projectID,
			CorrelationID:           correlationID,
			WorkflowName:            s.deleteWorkflow.Spec.Name,
			WorkflowVersion:         s.deleteWorkflow.Spec.Version,
			SubjectType:             "file",
			SubjectID:               file.ID,
			FileID:                  pgtype.Text{String: file.ID, Valid: true},
			Operation:               "delete",
			Status:                  batchStatusPending,
			CurrentStep:             "",
			EstimatedDuration:       initialPrediction.TotalMS,
			PredictionSampleCount:   initialPrediction.SampleCount,
			PredictionFallbackLevel: initialPrediction.FallbackLevel,
			Metrics:                 marshalJSONValue(initialMetrics),
			Prediction:              marshalJSONValue(initialPrediction),
			ErrorMessage:            "",
		}); err != nil {
			return "", fmt.Errorf("create delete workflow stat for file %s: %w", file.ID, err)
		}
	}

	return correlationID, nil
}

func (s *Service) newRunClient(ctx context.Context, conn pgx.Tx) (*workflowpkg.Client, error) {
	workflowStorage, err := storepgx.NewWorkflowDBStorageWithConnection(ctx, conn)
	if err != nil {
		return nil, fmt.Errorf("create transactional workflow storage: %w", err)
	}
	client, err := workflowpkg.NewClient(workflowpkg.WithStorage(workflowStorage))
	if err != nil {
		return nil, fmt.Errorf("create transactional workflow client: %w", err)
	}
	return client, nil
}

func (s *Service) handleTerminalFailure(ctx context.Context, run *workflowpkg.RunInfo, workflowErr error) {
	logger.Error("Workflow reached terminal failure", "workflow", run.Name, "run_id", run.ID, "err", workflowErr)
	message := "workflow failed"
	if workflowErr != nil {
		message = workflowErr.Error()
	}
	if err := s.failWorkflowStat(ctx, run.ID, message); err != nil {
		logger.Error("Failed to mark workflow stat as failed", "run_id", run.ID, "err", err)
	}
}

func nullText(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}
