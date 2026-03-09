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

type DescriptionWorkflowInput struct {
	RunID             string   `json:"run_id"`
	ProjectID         string   `json:"project_id"`
	CorrelationID     string   `json:"correlation_id"`
	JobID             int      `json:"job_id"`
	TotalJobs         int      `json:"total_jobs"`
	BatchSize         int      `json:"batch_size"`
	SourceCount       int32    `json:"source_count"`
	EntityCount       int32    `json:"entity_count"`
	RelationshipCount int32    `json:"relationship_count"`
	EntityIDs         []string `json:"entity_ids,omitempty"`
	RelationshipIDs   []string `json:"relationship_ids,omitempty"`
}

func (s *Service) newDescriptionWorkflow() workflowpkg.Workflow {
	return workflowpkg.MustDefineWorkflow(
		workflowpkg.WorkflowSpec{Name: "description", Version: "v1"},
		func(ctx context.Context, input any, step *workflowpkg.StepAPI) (result any, err error) {
			payload, err := decodeValue[DescriptionWorkflowInput](input)
			if err != nil {
				return nil, fmt.Errorf("decode description input: %w", err)
			}
			attrs := descriptionWorkflowLogAttrs(payload)
			startedAt := logWorkflowStarted("description", attrs)
			stepTimes := stepDurations{}
			metrics := descriptionMetrics{
				SourceCount:       payload.SourceCount,
				EntityCount:       payload.EntityCount,
				RelationshipCount: payload.RelationshipCount,
				BatchSize:         int32(payload.BatchSize),
			}
			defer func() {
				stepTimes.TotalMS = time.Since(startedAt).Milliseconds()
				logWorkflowFinished("description", startedAt, err, attrs)
			}()

			if _, describeMS, err := runLoggedStep(ctx, step, "describe", attrs, func() (any, error) {
				q := pgdb.New(s.db)
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, descriptionStatusProcessing, "describe"); err != nil {
					return nil, err
				}

				storageClient, err := storepgx.NewGraphDBStorageWithConnection(ctx, s.db, s.aiClient, nil)
				if err != nil {
					return nil, err
				}

				if len(payload.EntityIDs) > 0 || len(payload.RelationshipIDs) > 0 {
					eg, gCtx := errgroup.WithContext(ctx)
					if len(payload.EntityIDs) > 0 {
						entityIDs := append([]string(nil), payload.EntityIDs...)
						eg.Go(func() error {
							return storageClient.GenerateEntityDescriptions(gCtx, entityIDs)
						})
					}
					if len(payload.RelationshipIDs) > 0 {
						relationshipIDs := append([]string(nil), payload.RelationshipIDs...)
						eg.Go(func() error {
							return storageClient.GenerateRelationshipDescriptions(gCtx, relationshipIDs)
						})
					}
					if err := eg.Wait(); err != nil {
						return nil, err
					}
				}

				if err := s.completeWorkflowStat(ctx, payload.RunID, descriptionStatusCompleted); err != nil {
					return nil, err
				}

				allCompleted, err := q.AreAllWorkflowStatsCompletedBySubjectType(ctx, pgdb.AreAllWorkflowStatsCompletedBySubjectTypeParams{
					CorrelationID: payload.CorrelationID,
					SubjectType:   "description",
				})
				if err != nil {
					return nil, err
				}
				if allCompleted {
					if err := s.markProjectReadyIfLatestCorrelation(ctx, payload.ProjectID, payload.CorrelationID); err != nil {
						return nil, err
					}
				}

				return map[string]bool{"described": true}, nil
			}); err != nil {
				return nil, err
			} else {
				stepTimes.DescribeMS = describeMS
			}

			if err := s.recordDescriptionHistory(ctx, payload, metrics, stepDurations{
				DescribeMS: stepTimes.DescribeMS,
				TotalMS:    stepTimes.DescribeMS,
			}); err != nil {
				logger.Error("Failed to record description workflow history", "correlation_id", payload.CorrelationID, "job_id", payload.JobID, "err", err)
			}

			return map[string]bool{"completed": true}, nil
		},
		workflowpkg.WithWorkflowRetryPolicy(workflowpkg.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    int(util.GetEnvNumeric("WORKFLOW_MAX_ATTEMPTS", 3)),
		}),
	)
}
