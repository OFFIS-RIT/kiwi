package workflow

import (
	"context"
	"fmt"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

const (
	tokenBucketSize          = 512
	chunkBucketSize          = 5
	sourceBucketSize         = 5
	minExactProcessSamples   = 8
	minTypedProcessSamples   = 5
	minWorkflowSamples       = 3
	minExactSourceSamples    = 6
	minSourceFallbackSamples = 3
)

func (s *Service) predictProcessDurations(ctx context.Context, operation string, metrics batchMetrics) durationPrediction {
	q := pgdb.New(s.db)
	aiAdapter, chatModel, _ := currentAIConfig()
	tokenBucket := bucketIndex(metrics.EstimatedTokens, tokenBucketSize)
	chunkBucket := int32(-1)
	if metrics.ChunkCount > 0 {
		chunkBucket = bucketIndex(int64(metrics.ChunkCount), chunkBucketSize)
	}

	exact, err := q.PredictWorkflowStepDurationsExact(ctx, pgdb.PredictWorkflowStepDurationsExactParams{
		WorkflowName:    s.processWorkflow.Spec.Name,
		WorkflowVersion: s.processWorkflow.Spec.Version,
		Operation:       operation,
		FileType:        metrics.FileType,
		AiAdapter:       aiAdapter,
		ChatModel:       chatModel,
		NeedsOcr:        metrics.NeedsOCR,
		TokenBucket:     tokenBucket - 1,
		TokenBucket_2:   tokenBucket + 1,
		Column10:        chunkBucket,
		ChunkBucket:     chunkBucket + 1,
	})
	if err != nil {
		logger.Error("Failed to query exact process prediction", "err", err, "operation", operation, "file_type", metrics.FileType)
	} else if exact.SampleCount >= minExactProcessSamples && totalFromStepDurations(exact.PreprocessMs, exact.MetadataMs, exact.ChunkMs, exact.ExtractMs, exact.DedupeMs, exact.SaveMs, exact.DescribeMs) > 0 {
		return normalizePrediction(durationPrediction{
			PreprocessMS:  exact.PreprocessMs,
			MetadataMS:    exact.MetadataMs,
			ChunkMS:       exact.ChunkMs,
			ExtractMS:     exact.ExtractMs,
			DedupeMS:      exact.DedupeMs,
			SaveMS:        exact.SaveMs,
			DescribeMS:    exact.DescribeMs,
			TotalMS:       totalFromStepDurations(exact.PreprocessMs, exact.MetadataMs, exact.ChunkMs, exact.ExtractMs, exact.DedupeMs, exact.SaveMs, exact.DescribeMs),
			SampleCount:   exact.SampleCount,
			FallbackLevel: 0,
		})
	}

	byFileType, err := q.PredictWorkflowStepDurationsByFileType(ctx, pgdb.PredictWorkflowStepDurationsByFileTypeParams{
		WorkflowName:    s.processWorkflow.Spec.Name,
		WorkflowVersion: s.processWorkflow.Spec.Version,
		Operation:       operation,
		FileType:        metrics.FileType,
		NeedsOcr:        metrics.NeedsOCR,
		TokenBucket:     tokenBucket - 1,
		TokenBucket_2:   tokenBucket + 1,
	})
	if err != nil {
		logger.Error("Failed to query file-type process prediction", "err", err, "operation", operation, "file_type", metrics.FileType)
	} else if byFileType.SampleCount >= minTypedProcessSamples && totalFromStepDurations(byFileType.PreprocessMs, byFileType.MetadataMs, byFileType.ChunkMs, byFileType.ExtractMs, byFileType.DedupeMs, byFileType.SaveMs, byFileType.DescribeMs) > 0 {
		return normalizePrediction(durationPrediction{
			PreprocessMS:  byFileType.PreprocessMs,
			MetadataMS:    byFileType.MetadataMs,
			ChunkMS:       byFileType.ChunkMs,
			ExtractMS:     byFileType.ExtractMs,
			DedupeMS:      byFileType.DedupeMs,
			SaveMS:        byFileType.SaveMs,
			DescribeMS:    byFileType.DescribeMs,
			TotalMS:       totalFromStepDurations(byFileType.PreprocessMs, byFileType.MetadataMs, byFileType.ChunkMs, byFileType.ExtractMs, byFileType.DedupeMs, byFileType.SaveMs, byFileType.DescribeMs),
			SampleCount:   byFileType.SampleCount,
			FallbackLevel: 1,
		})
	}

	byWorkflow, err := q.PredictWorkflowStepDurationsByWorkflow(ctx, pgdb.PredictWorkflowStepDurationsByWorkflowParams{
		WorkflowName:    s.processWorkflow.Spec.Name,
		WorkflowVersion: s.processWorkflow.Spec.Version,
		Operation:       operation,
	})
	if err != nil {
		logger.Error("Failed to query workflow-level process prediction", "err", err, "operation", operation)
	} else if byWorkflow.SampleCount >= minWorkflowSamples && totalFromStepDurations(byWorkflow.PreprocessMs, byWorkflow.MetadataMs, byWorkflow.ChunkMs, byWorkflow.ExtractMs, byWorkflow.DedupeMs, byWorkflow.SaveMs, byWorkflow.DescribeMs) > 0 {
		return normalizePrediction(durationPrediction{
			PreprocessMS:  byWorkflow.PreprocessMs,
			MetadataMS:    byWorkflow.MetadataMs,
			ChunkMS:       byWorkflow.ChunkMs,
			ExtractMS:     byWorkflow.ExtractMs,
			DedupeMS:      byWorkflow.DedupeMs,
			SaveMS:        byWorkflow.SaveMs,
			DescribeMS:    byWorkflow.DescribeMs,
			TotalMS:       totalFromStepDurations(byWorkflow.PreprocessMs, byWorkflow.MetadataMs, byWorkflow.ChunkMs, byWorkflow.ExtractMs, byWorkflow.DedupeMs, byWorkflow.SaveMs, byWorkflow.DescribeMs),
			SampleCount:   byWorkflow.SampleCount,
			FallbackLevel: 2,
		})
	}

	return heuristicProcessPrediction(metrics)
}

func (s *Service) predictDeleteDurations(ctx context.Context, metrics batchMetrics) durationPrediction {
	q := pgdb.New(s.db)
	byWorkflow, err := q.PredictWorkflowStepDurationsByWorkflow(ctx, pgdb.PredictWorkflowStepDurationsByWorkflowParams{
		WorkflowName:    s.deleteWorkflow.Spec.Name,
		WorkflowVersion: s.deleteWorkflow.Spec.Version,
		Operation:       "delete",
	})
	if err != nil {
		logger.Error("Failed to query delete prediction", "err", err)
	} else if byWorkflow.SampleCount >= minWorkflowSamples && totalFromStepDurations(byWorkflow.PreprocessMs, byWorkflow.MetadataMs, byWorkflow.ChunkMs, byWorkflow.ExtractMs, byWorkflow.DedupeMs, byWorkflow.SaveMs, byWorkflow.DescribeMs) > 0 {
		totalMS := totalFromStepDurations(byWorkflow.PreprocessMs, byWorkflow.MetadataMs, byWorkflow.ChunkMs, byWorkflow.ExtractMs, byWorkflow.DedupeMs, byWorkflow.SaveMs, byWorkflow.DescribeMs)
		return normalizePrediction(durationPrediction{
			SaveMS:        max64(byWorkflow.SaveMs, totalMS-byWorkflow.DescribeMs),
			DescribeMS:    byWorkflow.DescribeMs,
			TotalMS:       totalMS,
			SampleCount:   byWorkflow.SampleCount,
			FallbackLevel: 2,
		})
	}

	return heuristicDeletePrediction(metrics)
}

func (s *Service) predictDescriptionDuration(ctx context.Context, metrics descriptionMetrics) durationPrediction {
	q := pgdb.New(s.db)
	aiAdapter, chatModel, _ := currentAIConfig()
	sourceBucket := bucketIndex(int64(metrics.SourceCount), sourceBucketSize)

	exact, err := q.PredictDescriptionDurationExact(ctx, pgdb.PredictDescriptionDurationExactParams{
		WorkflowVersion: s.descriptionWorkflow.Spec.Version,
		AiAdapter:       aiAdapter,
		ChatModel:       chatModel,
		SourceBucket:    sourceBucket - 1,
		SourceBucket_2:  sourceBucket + 1,
	})
	if err != nil {
		logger.Error("Failed to query exact description prediction", "err", err)
	} else if exact.SampleCount >= minExactSourceSamples && exact.TotalMs > 0 {
		return normalizePrediction(durationPrediction{
			DescribeMS:    exact.TotalMs,
			TotalMS:       exact.TotalMs,
			SampleCount:   exact.SampleCount,
			FallbackLevel: 0,
		})
	}

	bySource, err := q.PredictDescriptionDurationByModel(ctx, pgdb.PredictDescriptionDurationByModelParams{
		WorkflowVersion: s.descriptionWorkflow.Spec.Version,
		SourceBucket:    sourceBucket - 1,
		SourceBucket_2:  sourceBucket + 1,
	})
	if err != nil {
		logger.Error("Failed to query fallback description prediction", "err", err)
	} else if bySource.SampleCount >= minSourceFallbackSamples && bySource.TotalMs > 0 {
		return normalizePrediction(durationPrediction{
			DescribeMS:    bySource.TotalMs,
			TotalMS:       bySource.TotalMs,
			SampleCount:   bySource.SampleCount,
			FallbackLevel: 1,
		})
	}

	return heuristicDescriptionPrediction(metrics)
}

func heuristicProcessPrediction(metrics batchMetrics) durationPrediction {
	preprocessMS := max64(200, 40*metrics.TextBytes/1024)
	metadataMS := max64(300, 15*metrics.EstimatedTokens)
	chunkBasis := max64(int64(metrics.ChunkCount), max64(1, metrics.EstimatedTokens/700))
	chunkMS := max64(150, 80*chunkBasis)
	extractMS := max64(1200, 900*chunkBasis)
	dedupeMS := max64(250, int64(metrics.EntityCount)*40+int64(metrics.RelationshipCount)*35+chunkBasis*60)
	saveMS := max64(200, int64(metrics.EntityCount)*15+int64(metrics.RelationshipCount)*15+chunkBasis*25)
	if metrics.NeedsOCR {
		preprocessMS *= 2
		extractMS = max64(extractMS, 1500*chunkBasis)
	}

	return normalizePrediction(durationPrediction{
		PreprocessMS:  preprocessMS,
		MetadataMS:    metadataMS,
		ChunkMS:       chunkMS,
		ExtractMS:     extractMS,
		DedupeMS:      dedupeMS,
		SaveMS:        saveMS,
		TotalMS:       preprocessMS + metadataMS + chunkMS + extractMS + dedupeMS + saveMS,
		FallbackLevel: 3,
	})
}

func heuristicDeletePrediction(metrics batchMetrics) durationPrediction {
	saveMS := max64(300, int64(metrics.EntityCount)*25+int64(metrics.RelationshipCount)*25)
	describeMS := max64(200, int64(metrics.EntityCount+metrics.RelationshipCount)*250)
	return normalizePrediction(durationPrediction{
		SaveMS:        saveMS,
		DescribeMS:    describeMS,
		TotalMS:       saveMS + describeMS,
		FallbackLevel: 3,
	})
}

func heuristicDescriptionPrediction(metrics descriptionMetrics) durationPrediction {
	describeMS := max64(400, int64(metrics.SourceCount)*350+int64(metrics.EntityCount+metrics.RelationshipCount)*150)
	return normalizePrediction(durationPrediction{
		DescribeMS:    describeMS,
		TotalMS:       describeMS,
		FallbackLevel: 2,
	})
}

func normalizePrediction(prediction durationPrediction) durationPrediction {
	if prediction.TotalMS <= 0 {
		prediction.TotalMS = prediction.PreprocessMS + prediction.MetadataMS + prediction.ChunkMS + prediction.ExtractMS + prediction.DedupeMS + prediction.SaveMS + prediction.DescribeMS
	}
	if prediction.TotalMS <= 0 {
		prediction.TotalMS = 1
	}

	if prediction.PreprocessMS < 0 {
		prediction.PreprocessMS = 0
	}
	if prediction.MetadataMS < 0 {
		prediction.MetadataMS = 0
	}
	if prediction.ChunkMS < 0 {
		prediction.ChunkMS = 0
	}
	if prediction.ExtractMS < 0 {
		prediction.ExtractMS = 0
	}
	if prediction.DedupeMS < 0 {
		prediction.DedupeMS = 0
	}
	if prediction.SaveMS < 0 {
		prediction.SaveMS = 0
	}
	if prediction.DescribeMS < 0 {
		prediction.DescribeMS = 0
	}

	summed := prediction.PreprocessMS + prediction.MetadataMS + prediction.ChunkMS + prediction.ExtractMS + prediction.DedupeMS + prediction.SaveMS + prediction.DescribeMS
	if summed <= 0 {
		prediction.SaveMS = prediction.TotalMS
		summed = prediction.TotalMS
	}
	if prediction.TotalMS < summed {
		prediction.TotalMS = summed
	}

	return prediction
}

func bucketIndex(value int64, size int64) int32 {
	if value <= 0 || size <= 0 {
		return 0
	}
	return int32(value / size)
}

func max64(values ...int64) int64 {
	var result int64
	for idx, value := range values {
		if idx == 0 || value > result {
			result = value
		}
	}
	return result
}

func totalFromStepDurations(values ...int64) int64 {
	var total int64
	for _, value := range values {
		if value > 0 {
			total += value
		}
	}
	return total
}

func (prediction durationPrediction) String() string {
	return fmt.Sprintf("total=%d preprocess=%d metadata=%d chunk=%d extract=%d dedupe=%d save=%d describe=%d samples=%d fallback=%d confidence=%s", prediction.TotalMS, prediction.PreprocessMS, prediction.MetadataMS, prediction.ChunkMS, prediction.ExtractMS, prediction.DedupeMS, prediction.SaveMS, prediction.DescribeMS, prediction.SampleCount, prediction.FallbackLevel, util.ETAConfidenceFromPrediction(prediction.SampleCount, prediction.FallbackLevel))
}
