package util

import (
	"fmt"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

type BatchStepProgress struct {
	Pending       string `json:"pending,omitempty"`
	Preprocessing string `json:"preprocessing,omitempty"`
	Metadata      string `json:"metadata,omitempty"`
	Chunking      string `json:"chunking,omitempty"`
	Extracting    string `json:"extracting,omitempty"`
	Deduplicating string `json:"deduplicating,omitempty"`
	Saving        string `json:"saving,omitempty"`
	Describing    string `json:"describing,omitempty"`
	Completed     string `json:"completed,omitempty"`
	Failed        string `json:"failed,omitempty"`
}

type BatchProgress struct {
	Step              *BatchStepProgress
	Percentage        *int32
	EstimatedDuration *int64
	TimeRemaining     *int64
	EtaConfidence     *string
	EtaSampleCount    *int32
}

const (
	fileBatchProgressStepCount   int64 = 6
	processFilePhasePercentage   int32 = 90
	processDescriptionPercentage int32 = 10
)

func BuildBatchProgress(progress pgdb.GetProjectFullProgressRow) BatchProgress {
	batchTotal := int64(progress.BatchTotalCount)
	descTotal := int64(progress.DescriptionTotalCount)
	if batchTotal <= 0 && descTotal <= 0 {
		return BatchProgress{}
	}

	stepProgress := BatchStepProgress{}
	hasStep := false

	if batchTotal > 0 {
		if progress.BatchPendingCount > 0 {
			stepProgress.Pending = fmt.Sprintf("%d/%d", progress.BatchPendingCount, batchTotal)
			hasStep = true
		}
		if progress.BatchPreprocessingCount > 0 {
			stepProgress.Preprocessing = fmt.Sprintf("%d/%d", progress.BatchPreprocessingCount, batchTotal)
			hasStep = true
		}
		if progress.BatchMetadataCount > 0 {
			stepProgress.Metadata = fmt.Sprintf("%d/%d", progress.BatchMetadataCount, batchTotal)
			hasStep = true
		}
		if progress.BatchChunkingCount > 0 {
			stepProgress.Chunking = fmt.Sprintf("%d/%d", progress.BatchChunkingCount, batchTotal)
			hasStep = true
		}
		if progress.BatchExtractingCount > 0 {
			stepProgress.Extracting = fmt.Sprintf("%d/%d", progress.BatchExtractingCount, batchTotal)
			hasStep = true
		}
		if progress.BatchDeduplicatingCount > 0 {
			stepProgress.Deduplicating = fmt.Sprintf("%d/%d", progress.BatchDeduplicatingCount, batchTotal)
			hasStep = true
		}
		if progress.BatchSavingCount > 0 {
			stepProgress.Saving = fmt.Sprintf("%d/%d", progress.BatchSavingCount, batchTotal)
			hasStep = true
		}
		if progress.BatchCompletedCount > 0 {
			stepProgress.Completed = fmt.Sprintf("%d/%d", progress.BatchCompletedCount, batchTotal)
			hasStep = true
		}
		if progress.BatchFailedCount > 0 {
			stepProgress.Failed = fmt.Sprintf("%d/%d", progress.BatchFailedCount, batchTotal)
			hasStep = true
		}
	}

	batchDescribingCount := int64(progress.BatchDescribingCount)
	descriptionJobCount := int64(progress.DescriptionPendingCount) + int64(progress.DescriptionProcessingCount)
	if batchDescribingCount > 0 || descTotal > 0 {
		totalDescribing := batchDescribingCount + descTotal
		activeDescribing := batchDescribingCount + descriptionJobCount
		if activeDescribing > 0 {
			stepProgress.Describing = fmt.Sprintf("%d/%d", activeDescribing, totalDescribing)
			hasStep = true
		}
		if progress.DescriptionFailedCount > 0 {
			stepProgress.Failed = fmt.Sprintf("%d/%d", int64(progress.BatchFailedCount)+int64(progress.DescriptionFailedCount), batchTotal+totalDescribing)
			hasStep = true
		}
	}

	batchProgress := BatchProgress{}
	if hasStep {
		batchProgress.Step = &stepProgress
	}

	percentage := CalculateBatchProgressPercentage(progress)
	batchProgress.Percentage = &percentage

	if progress.TotalEstimatedDuration > 0 {
		batchProgress.EstimatedDuration = &progress.TotalEstimatedDuration
	}
	if progress.RemainingEstimatedDuration > 0 {
		batchProgress.TimeRemaining = &progress.RemainingEstimatedDuration
	}
	if progress.PredictionActiveCount > 0 {
		confidence := ETAConfidenceFromPrediction(progress.PredictionMinSampleCount, progress.PredictionMaxFallbackLevel)
		batchProgress.EtaConfidence = &confidence
		sampleCount := progress.PredictionMinSampleCount
		batchProgress.EtaSampleCount = &sampleCount
	}

	return batchProgress
}

func CalculateBatchProgressPercentage(progress pgdb.GetProjectFullProgressRow) int32 {
	if progress.BatchHasProcessOperation && !progress.BatchHasDeleteOperation {
		return calculateProcessBatchProgressPercentage(progress)
	}

	return calculateOverallBatchProgressPercentage(progress)
}

func calculateProcessBatchProgressPercentage(progress pgdb.GetProjectFullProgressRow) int32 {
	batchTotal := int64(progress.BatchTotalCount)
	descTotal := int64(progress.DescriptionTotalCount)

	if batchTotal <= 0 {
		if descTotal <= 0 {
			return 0
		}
		return calculateDescriptionProgressPercentage(progress)
	}

	filePct := calculateFileProgressPercentage(progress)
	if filePct < 100 {
		return scalePercentage(filePct, processFilePhasePercentage)
	}

	if descTotal <= 0 {
		return processFilePhasePercentage
	}

	return processFilePhasePercentage + scalePercentage(calculateDescriptionProgressPercentage(progress), processDescriptionPercentage)
}

func calculateOverallBatchProgressPercentage(progress pgdb.GetProjectFullProgressRow) int32 {
	if progress.TotalEstimatedDuration > 0 {
		return calculateDurationProgressPercentage(progress.TotalEstimatedDuration, progress.RemainingEstimatedDuration)
	}

	batchTotal := int64(progress.BatchTotalCount)
	descTotal := int64(progress.DescriptionTotalCount)

	if batchTotal == 0 {
		if descTotal == 0 {
			return 0
		}
		return calculateDescriptionProgressPercentage(progress)
	}

	if descTotal == 0 {
		return calculateFileProgressPercentage(progress)
	}

	filePct := calculateFileProgressPercentage(progress)
	descPct := calculateDescriptionProgressPercentage(progress)
	return (filePct + descPct) / 2
}

func ETAConfidenceFromPrediction(sampleCount int32, fallbackLevel int32) string {
	switch {
	case sampleCount >= 50 && fallbackLevel == 0:
		return "high"
	case sampleCount >= 15 && fallbackLevel <= 1:
		return "medium"
	default:
		return "low"
	}
}

func calculateFileBatchProgressPercentage(
	total int64,
	preprocessing int64,
	metadata int64,
	chunking int64,
	extracting int64,
	deduplicating int64,
	saving int64,
	describing int64,
	completed int64,
) int32 {
	if total <= 0 {
		return 0
	}

	totalWork := total * fileBatchProgressStepCount
	completedWork := min(preprocessing+
		metadata*2+
		chunking*3+
		extracting*4+
		deduplicating*5+
		saving*6+
		describing*6+
		completed*6, totalWork)

	return int32(completedWork * 100 / totalWork)
}

func calculateFileProgressPercentage(progress pgdb.GetProjectFullProgressRow) int32 {
	if progress.BatchEstimatedDuration > 0 {
		return calculateDurationProgressPercentage(progress.BatchEstimatedDuration, progress.BatchRemainingEstimatedDuration)
	}

	return calculateFileBatchProgressPercentage(
		int64(progress.BatchTotalCount),
		int64(progress.BatchPreprocessingCount),
		int64(progress.BatchMetadataCount),
		int64(progress.BatchChunkingCount),
		int64(progress.BatchExtractingCount),
		int64(progress.BatchDeduplicatingCount),
		int64(progress.BatchSavingCount),
		int64(progress.BatchDescribingCount),
		int64(progress.BatchCompletedCount),
	)
}

func calculateDescriptionProgressPercentage(progress pgdb.GetProjectFullProgressRow) int32 {
	descTotal := int64(progress.DescriptionTotalCount)
	if descTotal <= 0 {
		return 0
	}
	if progress.DescriptionEstimatedDuration > 0 {
		return calculateDurationProgressPercentage(progress.DescriptionEstimatedDuration, progress.DescriptionRemainingEstimatedDuration)
	}
	return int32(int64(progress.DescriptionCompletedCount) * 100 / descTotal)
}

func calculateDurationProgressPercentage(total int64, remaining int64) int32 {
	if total <= 0 {
		return 0
	}
	completed := total - remaining
	if completed < 0 {
		completed = 0
	}
	if completed > total {
		completed = total
	}
	return int32(completed * 100 / total)
}

func scalePercentage(pct int32, max int32) int32 {
	if pct <= 0 || max <= 0 {
		return 0
	}
	if pct >= 100 {
		return max
	}
	return pct * max / 100
}
