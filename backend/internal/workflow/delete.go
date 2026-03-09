package workflow

import (
	"context"
	"fmt"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	storepgx "github.com/OFFIS-RIT/kiwi/backend/pkg/store/pgx"
	workflowpkg "github.com/OFFIS-RIT/kiwi/backend/pkg/workflow"

	"golang.org/x/sync/errgroup"
)

type DeleteWorkflowInput struct {
	RunID         string `json:"run_id"`
	ProjectID     string `json:"project_id"`
	FileID        string `json:"file_id"`
	FileName      string `json:"file_name"`
	FileKey       string `json:"file_key"`
	CorrelationID string `json:"correlation_id"`
	BatchID       int    `json:"batch_id"`
	TotalBatches  int    `json:"total_batches"`
}

type deleteWorkflowResult struct {
	EntityIDs       []string `json:"entity_ids"`
	RelationshipIDs []string `json:"relationship_ids"`
}

func (s *Service) newDeleteWorkflow() workflowpkg.Workflow {
	return workflowpkg.MustDefineWorkflow(
		workflowpkg.WorkflowSpec{Name: "delete", Version: "v1"},
		func(ctx context.Context, input any, step *workflowpkg.StepAPI) (workflowResult any, err error) {
			payload, err := decodeValue[DeleteWorkflowInput](input)
			if err != nil {
				return nil, fmt.Errorf("decode delete input: %w", err)
			}
			attrs := deleteWorkflowLogAttrs(payload)
			startedAt := logWorkflowStarted("delete", attrs)
			stepTimes := stepDurations{}
			metrics := batchMetrics{
				FileType: string(fileTypeFromName(payload.FileName)),
				NeedsOCR: requiresOCR(payload.FileName),
			}
			defer func() {
				stepTimes.TotalMS = time.Since(startedAt).Milliseconds()
				logWorkflowFinished("delete", startedAt, err, attrs)
			}()
			if err := s.updateWorkflowStatMetrics(ctx, payload.RunID, metrics); err != nil {
				return nil, err
			}

			deleteRaw, deleteMS, err := runLoggedStep(ctx, step, "delete", attrs, func() (any, error) {
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, batchStatusSaving, "delete"); err != nil {
					return nil, err
				}
				return s.deleteFileAndCollectAffected(ctx, payload)
			})
			if err != nil {
				return nil, err
			}
			stepTimes.SaveMS = deleteMS
			deleteResult, err := decodeValue[deleteWorkflowResult](deleteRaw)
			if err != nil {
				return nil, fmt.Errorf("decode delete result: %w", err)
			}
			metrics.EntityCount = int32(len(deleteResult.EntityIDs))
			metrics.RelationshipCount = int32(len(deleteResult.RelationshipIDs))
			if err := s.updateWorkflowStatMetrics(ctx, payload.RunID, metrics); err != nil {
				return nil, err
			}
			if err := s.persistWorkflowStatPrediction(ctx, payload.RunID, s.predictDeleteDurations(ctx, metrics)); err != nil {
				logger.Error("Failed to persist delete prediction", "run_id", payload.RunID, "err", err)
			}

			if _, describeMS, err := runLoggedStep(ctx, step, "descriptions", attrs, func() (any, error) {
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, batchStatusDescribing, "descriptions"); err != nil {
					return nil, err
				}

				storageClient, err := storepgx.NewGraphDBStorageWithConnection(ctx, s.db, s.aiClient, nil)
				if err != nil {
					return nil, err
				}

				eg, gCtx := errgroup.WithContext(ctx)
				if len(deleteResult.EntityIDs) > 0 {
					ids := deleteResult.EntityIDs
					eg.Go(func() error {
						return storageClient.GenerateEntityDescriptions(gCtx, ids)
					})
				}
				if len(deleteResult.RelationshipIDs) > 0 {
					ids := deleteResult.RelationshipIDs
					eg.Go(func() error {
						return storageClient.GenerateRelationshipDescriptions(gCtx, ids)
					})
				}
				if err := eg.Wait(); err != nil {
					return nil, err
				}

				return map[string]bool{"updated": true}, nil
			}); err != nil {
				return nil, err
			} else {
				stepTimes.DescribeMS = describeMS
			}

			if err := s.completeWorkflowStat(ctx, payload.RunID, batchStatusCompleted); err != nil {
				return nil, err
			}

			if err := s.recordDeleteHistory(ctx, payload, metrics, stepDurations{
				SaveMS:     stepTimes.SaveMS,
				DescribeMS: stepTimes.DescribeMS,
				TotalMS:    stepTimes.SaveMS + stepTimes.DescribeMS,
			}); err != nil {
				logger.Error("Failed to record delete workflow history", "correlation_id", payload.CorrelationID, "batch_id", payload.BatchID, "err", err)
			}

			allCompleted, err := pgdb.New(s.db).AreAllWorkflowStatsCompletedBySubjectType(ctx, pgdb.AreAllWorkflowStatsCompletedBySubjectTypeParams{
				CorrelationID: payload.CorrelationID,
				SubjectType:   "file",
			})
			if err != nil {
				return nil, err
			}
			if allCompleted {
				if err := s.markProjectReadyIfLatestCorrelation(ctx, payload.ProjectID, payload.CorrelationID); err != nil {
					return nil, err
				}
			}

			return map[string]bool{"deleted": true}, nil
		},
		workflowpkg.WithWorkflowRetryPolicy(workflowpkg.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    int(util.GetEnvNumeric("WORKFLOW_MAX_ATTEMPTS", 3)),
		}),
	)
}

func (s *Service) deleteFileAndCollectAffected(ctx context.Context, payload DeleteWorkflowInput) (deleteWorkflowResult, error) {
	result := deleteWorkflowResult{}

	err := s.withProjectLock(ctx, payload.ProjectID, func(lockCtx context.Context) error {
		q := pgdb.New(s.db)
		storageClient, err := storepgx.NewGraphDBStorageWithConnection(lockCtx, s.db, s.aiClient, nil)
		if err != nil {
			return err
		}

		unitIDs, err := q.GetTextUnitIdsForFiles(lockCtx, []string{payload.FileID})
		if err != nil {
			return err
		}

		if len(unitIDs) > 0 {
			entities, err := q.GetEntitiesWithSourcesFromUnits(lockCtx, pgdb.GetEntitiesWithSourcesFromUnitsParams{
				Column1:   unitIDs,
				ProjectID: payload.ProjectID,
			})
			if err != nil {
				return err
			}
			for _, entity := range entities {
				result.EntityIDs = append(result.EntityIDs, entity.ID)
			}

			relationships, err := q.GetRelationshipsWithSourcesFromUnits(lockCtx, pgdb.GetRelationshipsWithSourcesFromUnitsParams{
				Column1:   unitIDs,
				ProjectID: payload.ProjectID,
			})
			if err != nil {
				return err
			}
			for _, relationship := range relationships {
				result.RelationshipIDs = append(result.RelationshipIDs, relationship.ID)
			}
		}

		return storageClient.DeleteFile(lockCtx, payload.FileID, payload.ProjectID)
	})
	if err != nil {
		return deleteWorkflowResult{}, err
	}

	s.deleteArtifact(ctx, payload.FileKey)

	return result, nil
}
