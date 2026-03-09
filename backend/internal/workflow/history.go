package workflow

import (
	"context"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
)

type statSample struct {
	WorkflowName    string         `json:"workflow_name"`
	WorkflowVersion string         `json:"workflow_version"`
	ProjectID       string         `json:"project_id"`
	Operation       string         `json:"operation"`
	AI              statAIConfig   `json:"ai"`
	Features        map[string]any `json:"features"`
	DurationMS      int64          `json:"duration_ms"`
}

type statAIConfig struct {
	Adapter    string `json:"adapter"`
	ChatModel  string `json:"chat_model"`
	EmbedModel string `json:"embed_model"`
}

func (s *Service) recordProcessHistory(ctx context.Context, payload ProcessWorkflowInput, metrics batchMetrics, durations stepDurations) error {
	steps := map[string]int64{
		"workflow.process.preprocess": durations.PreprocessMS,
		"workflow.process.metadata":   durations.MetadataMS,
		"workflow.process.chunk":      durations.ChunkMS,
		"workflow.process.extract":    durations.ExtractMS,
		"workflow.process.dedupe":     durations.DedupeMS,
		"workflow.process.save":       durations.SaveMS,
	}
	return s.insertWorkflowStepSamples(ctx, payload.RunID, s.processWorkflow.Spec.Name, s.processWorkflow.Spec.Version, payload.ProjectID, payload.Operation, metricsToMap(metrics), steps)
}

func (s *Service) recordDeleteHistory(ctx context.Context, payload DeleteWorkflowInput, metrics batchMetrics, durations stepDurations) error {
	steps := map[string]int64{
		"workflow.delete.delete":       durations.SaveMS,
		"workflow.delete.descriptions": durations.DescribeMS,
	}
	return s.insertWorkflowStepSamples(ctx, payload.RunID, s.deleteWorkflow.Spec.Name, s.deleteWorkflow.Spec.Version, payload.ProjectID, "delete", metricsToMap(metrics), steps)
}

func (s *Service) recordDescriptionHistory(ctx context.Context, payload DescriptionWorkflowInput, metrics descriptionMetrics, durations stepDurations) error {
	steps := map[string]int64{
		"workflow.description.describe": durations.TotalMS,
	}
	return s.insertWorkflowStepSamples(ctx, payload.RunID, s.descriptionWorkflow.Spec.Name, s.descriptionWorkflow.Spec.Version, payload.ProjectID, "", metricsToMap(metrics), steps)
}

func (s *Service) insertWorkflowStepSamples(ctx context.Context, runID string, workflowName string, workflowVersion string, projectID string, operation string, features map[string]any, steps map[string]int64) error {
	q := pgdb.New(s.db)
	aiAdapter, chatModel, embedModel := currentAIConfig()
	for sampleType, durationMS := range steps {
		if durationMS <= 0 {
			continue
		}
		payload := statSample{
			WorkflowName:    workflowName,
			WorkflowVersion: workflowVersion,
			ProjectID:       projectID,
			Operation:       operation,
			AI: statAIConfig{
				Adapter:    aiAdapter,
				ChatModel:  chatModel,
				EmbedModel: embedModel,
			},
			Features:   features,
			DurationMS: durationMS,
		}
		if err := q.InsertStatSample(ctx, pgdb.InsertStatSampleParams{
			ID:    ids.New(),
			Type:  sampleType,
			RunID: nullText(runID),
			Data:  marshalJSONValue(payload),
		}); err != nil {
			return err
		}
	}
	return nil
}

func metricsToMap(value any) map[string]any {
	raw := marshalJSONValue(value)
	mapped, err := unmarshalInput[map[string]any](raw)
	if err != nil {
		return map[string]any{}
	}
	if mapped == nil {
		return map[string]any{}
	}
	return mapped
}
