package workflow

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/graph"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	storepgx "github.com/OFFIS-RIT/kiwi/backend/pkg/store/pgx"
	workflowpkg "github.com/OFFIS-RIT/kiwi/backend/pkg/workflow"
	"github.com/jackc/pgx/v5/pgtype"
)

type ProcessWorkflowInput struct {
	RunID         string `json:"run_id"`
	ProjectID     string `json:"project_id"`
	FileID        string `json:"file_id"`
	FileName      string `json:"file_name"`
	FileKey       string `json:"file_key"`
	CorrelationID string `json:"correlation_id"`
	BatchID       int    `json:"batch_id"`
	TotalBatches  int    `json:"total_batches"`
	Operation     string `json:"operation"`
}

func (s *Service) newProcessWorkflow() workflowpkg.Workflow {
	return workflowpkg.MustDefineWorkflow(
		workflowpkg.WorkflowSpec{Name: "process", Version: "v1"},
		func(ctx context.Context, input any, step *workflowpkg.StepAPI) (result any, err error) {
			payload, err := decodeValue[ProcessWorkflowInput](input)
			if err != nil {
				return nil, fmt.Errorf("decode process input: %w", err)
			}
			attrs := processWorkflowLogAttrs(payload)
			startedAt := logWorkflowStarted("process", attrs)
			stepTimes := stepDurations{}
			metrics, err := loadWorkflowStatMetrics[batchMetrics](ctx, s.db, payload.RunID)
			if err != nil {
				return nil, fmt.Errorf("load process metrics: %w", err)
			}
			defer func() {
				stepTimes.TotalMS = time.Since(startedAt).Milliseconds()
				logWorkflowFinished("process", startedAt, err, attrs)
			}()

			prefix := s.artifactPrefix(payload.ProjectID, payload.CorrelationID, payload.BatchID)

			preprocessRaw, preprocessMS, err := runLoggedStep(ctx, step, "preprocess", attrs, func() (any, error) {
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, batchStatusPreprocessing, "preprocess"); err != nil {
					return nil, err
				}

				file := s.buildGraphFile(payload)
				textBytes, err := file.GetText(ctx)
				if err != nil {
					return nil, err
				}
				text := string(textBytes)
				metrics = derivePreprocessMetrics(payload.FileName, file.FileType, text)
				if err := s.updateWorkflowStatMetrics(ctx, payload.RunID, metrics); err != nil {
					return nil, err
				}

				textKey, err := s.putTextArtifactAtKey(ctx, preprocessedTextKey(payload.FileKey), text)
				if err != nil {
					return nil, err
				}

				return preprocessOutput{
					TextKey:     textKey,
					FileType:    string(file.FileType),
					Description: file.Description,
				}, nil
			})
			if err != nil {
				return nil, err
			}
			stepTimes.PreprocessMS = preprocessMS
			if err := s.persistWorkflowStatPrediction(ctx, payload.RunID, s.predictProcessDurations(ctx, payload.Operation, metrics)); err != nil {
				logger.Error("Failed to persist process prediction", "run_id", payload.RunID, "err", err)
			}
			preprocess, err := decodeValue[preprocessOutput](preprocessRaw)
			if err != nil {
				return nil, fmt.Errorf("decode preprocess output: %w", err)
			}
			preprocessedText, err := s.readTextArtifact(ctx, preprocess.TextKey)
			if err != nil {
				return nil, err
			}
			metrics = derivePreprocessMetrics(payload.FileName, loader.GraphFileType(preprocess.FileType), preprocessedText)

			metadataRaw, metadataMS, err := runLoggedStep(ctx, step, "metadata", attrs, func() (any, error) {
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, batchStatusMetadata, "metadata"); err != nil {
					return nil, err
				}

				text, err := s.readTextArtifact(ctx, preprocess.TextKey)
				if err != nil {
					return nil, err
				}

				metadata, err := ai.ExtractDocumentMetadata(ctx, s.aiClient, payload.FileName, text)
				if err != nil {
					return nil, err
				}

				if err := pgdb.New(s.db).UpdateProjectFileMetadata(ctx, pgdb.UpdateProjectFileMetadataParams{
					ID:       payload.FileID,
					Metadata: nullText(metadata),
				}); err != nil {
					return nil, err
				}

				return metadata, nil
			})
			if err != nil {
				return nil, err
			}
			stepTimes.MetadataMS = metadataMS
			metadata, err := decodeValue[string](metadataRaw)
			if err != nil {
				return nil, fmt.Errorf("decode metadata output: %w", err)
			}

			chunkRaw, chunkMS, err := runLoggedStep(ctx, step, "chunk", attrs, func() (any, error) {
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, batchStatusChunking, "chunk"); err != nil {
					return nil, err
				}

				text, err := s.readTextArtifact(ctx, preprocess.TextKey)
				if err != nil {
					return nil, err
				}

				encoder, maxChunkSize := chunkConfig()
				chunks, err := graph.ChunkText(ctx, s.buildGraphFile(payload).FileType, text, encoder, maxChunkSize)
				if err != nil {
					return nil, err
				}

				units, err := graph.ExtractUnits(chunks, payload.FileID)
				if err != nil {
					return nil, err
				}
				metrics.ChunkCount = int32(len(units))
				if err := s.updateWorkflowStatMetrics(ctx, payload.RunID, metrics); err != nil {
					return nil, err
				}

				unitsKey, err := s.putJSONArtifact(ctx, prefix, "units.json", "units", unitsArtifact{Units: units})
				if err != nil {
					return nil, err
				}

				return chunkOutput{UnitsKey: unitsKey}, nil
			})
			if err != nil {
				return nil, err
			}
			stepTimes.ChunkMS = chunkMS
			if err := s.persistWorkflowStatPrediction(ctx, payload.RunID, s.predictProcessDurations(ctx, payload.Operation, metrics)); err != nil {
				logger.Error("Failed to persist process prediction", "run_id", payload.RunID, "err", err)
			}
			chunked, err := decodeValue[chunkOutput](chunkRaw)
			if err != nil {
				return nil, fmt.Errorf("decode chunk output: %w", err)
			}
			chunkArtifact, err := readJSONArtifact[unitsArtifact](ctx, s.s3, chunked.UnitsKey)
			if err != nil {
				return nil, err
			}
			metrics.ChunkCount = int32(len(chunkArtifact.Units))
			metrics.EntityCount = 0
			metrics.RelationshipCount = 0

			extractRaw, extractMS, err := runLoggedStep(ctx, step, "extract", attrs, func() (any, error) {
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, batchStatusExtracting, "extract"); err != nil {
					return nil, err
				}

				unitsData, err := readJSONArtifact[unitsArtifact](ctx, s.s3, chunked.UnitsKey)
				if err != nil {
					return nil, err
				}

				entities, relationships, err := graph.ExtractFromUnits(
					ctx,
					buildExtractFile(payload, preprocess, metadata),
					unitsData.Units,
					s.aiClient,
					int(util.GetEnvNumeric("GRAPH_MAX_RETRIES", 3)),
				)
				if err != nil {
					return nil, err
				}
				metrics.EntityCount = int32(len(entities))
				metrics.RelationshipCount = int32(len(relationships))
				if err := s.updateWorkflowStatMetrics(ctx, payload.RunID, metrics); err != nil {
					return nil, err
				}

				graphKey, err := s.putJSONArtifact(ctx, prefix, "graph.json", "graph", graphArtifact{
					Units:         unitsData.Units,
					Entities:      entities,
					Relationships: relationships,
				})
				if err != nil {
					return nil, err
				}

				return graphOutput{GraphKey: graphKey}, nil
			})
			if err != nil {
				return nil, err
			}
			stepTimes.ExtractMS = extractMS
			if err := s.persistWorkflowStatPrediction(ctx, payload.RunID, s.predictProcessDurations(ctx, payload.Operation, metrics)); err != nil {
				logger.Error("Failed to persist process prediction", "run_id", payload.RunID, "err", err)
			}
			extracted, err := decodeValue[graphOutput](extractRaw)
			if err != nil {
				return nil, fmt.Errorf("decode extract output: %w", err)
			}
			extractedArtifact, err := readJSONArtifact[graphArtifact](ctx, s.s3, extracted.GraphKey)
			if err != nil {
				return nil, err
			}
			metrics.EntityCount = int32(len(extractedArtifact.Entities))
			metrics.RelationshipCount = int32(len(extractedArtifact.Relationships))

			dedupeRaw, dedupeMS, err := runLoggedStep(ctx, step, "dedupe", attrs, func() (any, error) {
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, batchStatusDeduplicating, "dedupe"); err != nil {
					return nil, err
				}

				artifact, err := readJSONArtifact[graphArtifact](ctx, s.s3, extracted.GraphKey)
				if err != nil {
					return nil, err
				}

				entities, relationships, err := s.graphClient.LocalDedupe(ctx, artifact.Entities, artifact.Relationships, s.aiClient)
				if err != nil {
					return nil, err
				}

				graphKey, err := s.putJSONArtifact(ctx, prefix, "graph-deduped.json", "graph-deduped", graphArtifact{
					Units:         artifact.Units,
					Entities:      entities,
					Relationships: relationships,
				})
				if err != nil {
					return nil, err
				}

				return graphOutput{GraphKey: graphKey}, nil
			})
			if err != nil {
				return nil, err
			}
			stepTimes.DedupeMS = dedupeMS
			deduped, err := decodeValue[graphOutput](dedupeRaw)
			if err != nil {
				return nil, fmt.Errorf("decode dedupe output: %w", err)
			}
			dedupedArtifact, err := readJSONArtifact[graphArtifact](ctx, s.s3, deduped.GraphKey)
			if err != nil {
				return nil, err
			}
			metrics.EntityCount = int32(len(dedupedArtifact.Entities))
			metrics.RelationshipCount = int32(len(dedupedArtifact.Relationships))
			if err := s.updateWorkflowStatMetrics(ctx, payload.RunID, metrics); err != nil {
				return nil, err
			}
			if err := s.persistWorkflowStatPrediction(ctx, payload.RunID, s.predictProcessDurations(ctx, payload.Operation, metrics)); err != nil {
				logger.Error("Failed to persist process prediction", "run_id", payload.RunID, "err", err)
			}

			var saveMS int64
			if _, saveMS, err = runLoggedStep(ctx, step, "save", attrs, func() (any, error) {
				if err := s.updateWorkflowStatStep(ctx, payload.RunID, batchStatusSaving, "save"); err != nil {
					return nil, err
				}

				artifact, err := readJSONArtifact[graphArtifact](ctx, s.s3, deduped.GraphKey)
				if err != nil {
					return nil, err
				}

				if err := s.saveGraphArtifact(ctx, payload.ProjectID, payload.FileID, artifact); err != nil {
					return nil, err
				}

				if err := s.completeWorkflowStat(ctx, payload.RunID, batchStatusCompleted); err != nil {
					return nil, err
				}

				s.deleteArtifact(ctx, chunked.UnitsKey)
				s.deleteArtifact(ctx, extracted.GraphKey)
				s.deleteArtifact(ctx, deduped.GraphKey)

				if err := s.enqueueDescriptionWorkflowsIfReady(ctx, payload); err != nil {
					return nil, err
				}

				return map[string]bool{"saved": true}, nil
			}); err != nil {
				return nil, err
			}
			stepTimes.SaveMS = saveMS
			if err := s.recordProcessHistory(ctx, payload, metrics, stepDurations{
				PreprocessMS: stepTimes.PreprocessMS,
				MetadataMS:   stepTimes.MetadataMS,
				ChunkMS:      stepTimes.ChunkMS,
				ExtractMS:    stepTimes.ExtractMS,
				DedupeMS:     stepTimes.DedupeMS,
				SaveMS:       stepTimes.SaveMS,
				TotalMS:      stepTimes.PreprocessMS + stepTimes.MetadataMS + stepTimes.ChunkMS + stepTimes.ExtractMS + stepTimes.DedupeMS + stepTimes.SaveMS,
			}); err != nil {
				logger.Error("Failed to record process workflow history", "correlation_id", payload.CorrelationID, "batch_id", payload.BatchID, "err", err)
			}

			return map[string]bool{"processed": true}, nil
		},
		workflowpkg.WithWorkflowRetryPolicy(workflowpkg.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    int(util.GetEnvNumeric("WORKFLOW_MAX_ATTEMPTS", 3)),
		}),
	)
}

func (s *Service) saveGraphArtifact(ctx context.Context, projectID string, fileID string, artifact graphArtifact) error {
	graphID := projectID
	fileIDs := []string{fileID}

	return s.withProjectLock(ctx, projectID, func(lockCtx context.Context) error {
		storageClient, err := storepgx.NewGraphDBStorageWithConnection(lockCtx, s.db, s.aiClient, nil)
		if err != nil {
			return err
		}

		if _, err := storageClient.SaveUnits(lockCtx, artifact.Units); err != nil {
			_ = storageClient.RollbackFileData(ctx, fileIDs, projectID)
			return fmt.Errorf("save units: %w", err)
		}

		seedEntityIDs, err := storageClient.SaveEntities(lockCtx, artifact.Entities, graphID)
		if err != nil {
			_ = storageClient.RollbackFileData(ctx, fileIDs, projectID)
			return fmt.Errorf("save entities: %w", err)
		}

		if _, err := storageClient.SaveRelationships(lockCtx, artifact.Relationships, graphID); err != nil {
			_ = storageClient.RollbackFileData(ctx, fileIDs, projectID)
			return fmt.Errorf("save relationships: %w", err)
		}

		if len(seedEntityIDs) > 0 {
			if err := storageClient.DedupeAndMergeEntities(lockCtx, graphID, s.aiClient, seedEntityIDs); err != nil {
				_ = storageClient.RollbackFileData(ctx, fileIDs, projectID)
				return fmt.Errorf("dedupe entities: %w", err)
			}
		}

		return nil
	})
}

func (s *Service) enqueueDescriptionWorkflowsIfReady(ctx context.Context, payload ProcessWorkflowInput) error {
	return s.withCorrelationLock(ctx, payload.CorrelationID, "description-enqueue", func(lockCtx context.Context) error {
		q := pgdb.New(s.db)
		isLatest, err := s.isLatestCorrelation(lockCtx, payload.ProjectID, payload.CorrelationID)
		if err != nil {
			return err
		}
		if !isLatest {
			return nil
		}

		allCompleted, err := q.AreAllWorkflowStatsCompletedBySubjectType(lockCtx, pgdb.AreAllWorkflowStatsCompletedBySubjectTypeParams{
			CorrelationID: payload.CorrelationID,
			SubjectType:   "file",
		})
		if err != nil {
			return err
		}
		if !allCompleted {
			return nil
		}

		descriptionStats, err := q.GetWorkflowStatsByCorrelationAndSubjectType(lockCtx, pgdb.GetWorkflowStatsByCorrelationAndSubjectTypeParams{
			CorrelationID: payload.CorrelationID,
			SubjectType:   "description",
		})
		if err != nil {
			return err
		}
		batchSize := resolveDescriptionBatchSize(descriptionStats)
		existingDescriptionJobs := make(map[string]struct{}, len(descriptionStats))
		for _, stat := range descriptionStats {
			existingDescriptionJobs[stat.SubjectID] = struct{}{}
		}

		statsRows, err := q.GetWorkflowStatsByCorrelationAndSubjectType(lockCtx, pgdb.GetWorkflowStatsByCorrelationAndSubjectTypeParams{
			CorrelationID: payload.CorrelationID,
			SubjectType:   "file",
		})
		if err != nil {
			return err
		}

		fileIDs := make([]string, 0, len(statsRows))
		fileSet := make(map[string]struct{})
		for _, row := range statsRows {
			if !row.FileID.Valid {
				continue
			}
			fileID := row.FileID.String
			if _, exists := fileSet[fileID]; exists {
				continue
			}
			fileSet[fileID] = struct{}{}
			fileIDs = append(fileIDs, fileID)
		}

		entities, err := q.GetEntitiesWithSourcesFromFiles(lockCtx, pgdb.GetEntitiesWithSourcesFromFilesParams{
			Column1:   fileIDs,
			ProjectID: payload.ProjectID,
		})
		if err != nil {
			return err
		}
		sort.Slice(entities, func(i, j int) bool {
			return entities[i].ID < entities[j].ID
		})

		relationships, err := q.GetRelationshipsWithSourcesFromFiles(lockCtx, pgdb.GetRelationshipsWithSourcesFromFilesParams{
			Column1:   fileIDs,
			ProjectID: payload.ProjectID,
		})
		if err != nil {
			return err
		}
		sort.Slice(relationships, func(i, j int) bool {
			return relationships[i].ID < relationships[j].ID
		})

		entitySourceCounts := make(map[string]int32, len(entities))
		if len(entities) > 0 {
			rows, err := q.GetEntitySourceCountsByIDs(lockCtx, pgdb.GetEntitySourceCountsByIDsParams{
				Column1:   entityIDList(entities),
				ProjectID: payload.ProjectID,
			})
			if err != nil {
				return err
			}
			for _, row := range rows {
				entitySourceCounts[row.ID] = row.SourceCount
			}
		}

		relationshipSourceCounts := make(map[string]int32, len(relationships))
		if len(relationships) > 0 {
			rows, err := q.GetRelationshipSourceCountsByIDs(lockCtx, pgdb.GetRelationshipSourceCountsByIDsParams{
				Column1:   relationshipIDList(relationships),
				ProjectID: payload.ProjectID,
			})
			if err != nil {
				return err
			}
			for _, row := range rows {
				relationshipSourceCounts[row.ID] = row.SourceCount
			}
		}

		batches := buildDescriptionJobBatches(
			batchSize,
			entityIDList(entities),
			entitySourceCounts,
			relationshipIDList(relationships),
			relationshipSourceCounts,
		)

		totalJobs := len(batches)
		if totalJobs == 0 {
			return s.markProjectReadyIfLatestCorrelation(lockCtx, payload.ProjectID, payload.CorrelationID)
		}

		for jobID, batch := range batches {
			if _, exists := existingDescriptionJobs[fmt.Sprintf("%d", jobID)]; exists {
				continue
			}
			if err := s.enqueueDescriptionWorkflow(lockCtx, payload.ProjectID, payload.CorrelationID, jobID, totalJobs, batch.Metrics, batch.EntityIDs, batch.RelationshipIDs); err != nil {
				return err
			}
		}

		return nil
	})
}

func (s *Service) enqueueDescriptionWorkflow(ctx context.Context, projectID string, correlationID string, jobID int, totalJobs int, metrics descriptionMetrics, entityIDs []string, relationshipIDs []string) error {
	runID := workflowRunID("description", correlationID, jobID)
	prediction := s.predictDescriptionDuration(ctx, metrics)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin description enqueue transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	runClient, err := s.newRunClient(ctx, tx)
	if err != nil {
		return err
	}
	qtx := pgdb.New(tx)

	handle, err := runClient.RunWorkflow(ctx, s.descriptionWorkflow, DescriptionWorkflowInput{
		RunID:             runID,
		ProjectID:         projectID,
		CorrelationID:     correlationID,
		JobID:             jobID,
		TotalJobs:         totalJobs,
		BatchSize:         int(metrics.BatchSize),
		SourceCount:       metrics.SourceCount,
		EntityCount:       metrics.EntityCount,
		RelationshipCount: metrics.RelationshipCount,
		EntityIDs:         entityIDs,
		RelationshipIDs:   relationshipIDs,
	}, workflowpkg.WithRunID(runID), workflowpkg.WithIdempotencyKey(fmt.Sprintf("description:%s:%d", correlationID, jobID)))
	if err != nil {
		return err
	}
	if err := s.createWorkflowStat(ctx, qtx, pgdb.CreateWorkflowStatParams{
		ID:                      ids.New(),
		RunID:                   nullText(handle.ID()),
		ProjectID:               projectID,
		CorrelationID:           correlationID,
		WorkflowName:            s.descriptionWorkflow.Spec.Name,
		WorkflowVersion:         s.descriptionWorkflow.Spec.Version,
		SubjectType:             "description",
		SubjectID:               fmt.Sprintf("%d", jobID),
		FileID:                  pgtype.Text{},
		Operation:               "",
		Status:                  descriptionStatusPending,
		CurrentStep:             "",
		EstimatedDuration:       prediction.TotalMS,
		PredictionSampleCount:   prediction.SampleCount,
		PredictionFallbackLevel: prediction.FallbackLevel,
		Metrics:                 marshalJSONValue(metrics),
		Prediction:              marshalJSONValue(prediction),
		ErrorMessage:            "",
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit description enqueue transaction: %w", err)
	}
	return nil
}

func entityIDList(rows []pgdb.GetEntitiesWithSourcesFromFilesRow) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

func relationshipIDList(rows []pgdb.GetRelationshipsWithSourcesFromFilesRow) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

type descriptionJobBatch struct {
	EntityIDs       []string
	RelationshipIDs []string
	Metrics         descriptionMetrics
}

func resolveDescriptionBatchSize(existingStats []pgdb.WorkflowStat) int {
	for _, stat := range existingStats {
		metrics, err := unmarshalInput[descriptionMetrics](stat.Metrics)
		if err != nil {
			continue
		}
		if metrics.BatchSize > 0 {
			return int(metrics.BatchSize)
		}
		legacyBatchSize := metrics.EntityCount + metrics.RelationshipCount
		if legacyBatchSize > 0 {
			return int(legacyBatchSize)
		}
	}

	return max(1, int(util.GetEnvNumeric("AI_PARALLEL_REQ", 15)))
}

func buildDescriptionJobBatches(batchSize int, entityIDs []string, entitySourceCounts map[string]int32, relationshipIDs []string, relationshipSourceCounts map[string]int32) []descriptionJobBatch {
	if batchSize <= 0 {
		batchSize = 1
	}

	batches := make([]descriptionJobBatch, 0, (len(entityIDs)+len(relationshipIDs)+batchSize-1)/batchSize)
	entityIndex := 0
	relationshipIndex := 0

	for entityIndex < len(entityIDs) || relationshipIndex < len(relationshipIDs) {
		batch := descriptionJobBatch{
			EntityIDs:       make([]string, 0, batchSize),
			RelationshipIDs: make([]string, 0, batchSize),
			Metrics: descriptionMetrics{
				BatchSize: int32(batchSize),
			},
		}

		remainingSlots := batchSize
		for remainingSlots > 0 && entityIndex < len(entityIDs) {
			entityID := entityIDs[entityIndex]
			batch.EntityIDs = append(batch.EntityIDs, entityID)
			batch.Metrics.EntityCount++
			batch.Metrics.SourceCount += entitySourceCounts[entityID]
			entityIndex++
			remainingSlots--
		}

		for remainingSlots > 0 && relationshipIndex < len(relationshipIDs) {
			relationshipID := relationshipIDs[relationshipIndex]
			batch.RelationshipIDs = append(batch.RelationshipIDs, relationshipID)
			batch.Metrics.RelationshipCount++
			batch.Metrics.SourceCount += relationshipSourceCounts[relationshipID]
			relationshipIndex++
			remainingSlots--
		}

		if batch.Metrics.EntityCount == 0 && batch.Metrics.RelationshipCount == 0 {
			break
		}

		batches = append(batches, batch)
	}

	return batches
}
