package util

import (
	"fmt"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

type BatchStepProgress struct {
	Pending       string `json:"pending,omitempty"`
	Preprocessing string `json:"preprocessing,omitempty"`
	Preprocessed  string `json:"preprocessed,omitempty"`
	Extracting    string `json:"extracting,omitempty"`
	Indexing      string `json:"indexing,omitempty"`
	Describing    string `json:"describing,omitempty"`
	Completed     string `json:"completed,omitempty"`
	Failed        string `json:"failed,omitempty"`
}

type BatchProgress struct {
	Step              *BatchStepProgress
	Percentage        *int32
	EstimatedDuration *int64
	TimeRemaining     *int64
}

const (
	fileBatchProgressStepCount  int64 = 4
	totalProgressStepCount      int64 = 5
	fileBatchProgressWeightStep int64 = 4
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
		if progress.BatchPreprocessedCount > 0 {
			stepProgress.Preprocessed = fmt.Sprintf("%d/%d", progress.BatchPreprocessedCount, batchTotal)
			hasStep = true
		}
		if progress.BatchExtractingCount > 0 {
			stepProgress.Extracting = fmt.Sprintf("%d/%d", progress.BatchExtractingCount, batchTotal)
			hasStep = true
		}
		if progress.BatchIndexingCount > 0 {
			stepProgress.Indexing = fmt.Sprintf("%d/%d", progress.BatchIndexingCount, batchTotal)
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

	if descTotal > 0 {
		describingCount := int64(progress.DescriptionPendingCount) + int64(progress.DescriptionProcessingCount)
		if describingCount > 0 {
			stepProgress.Describing = fmt.Sprintf("%d/%d", describingCount, descTotal)
			hasStep = true
		}
		if progress.DescriptionFailedCount > 0 {
			stepProgress.Failed = fmt.Sprintf("%d/%d", int64(progress.BatchFailedCount)+int64(progress.DescriptionFailedCount), batchTotal+descTotal)
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

	return batchProgress
}

func CalculateBatchProgressPercentage(progress pgdb.GetProjectFullProgressRow) int32 {
	batchTotal := int64(progress.BatchTotalCount)
	descTotal := int64(progress.DescriptionTotalCount)

	filePct := calculateFileBatchProgressPercentage(
		batchTotal,
		int64(progress.BatchPreprocessingCount),
		int64(progress.BatchPreprocessedCount),
		int64(progress.BatchExtractingCount),
		int64(progress.BatchIndexingCount),
		int64(progress.BatchCompletedCount),
	)

	if batchTotal == 0 {
		if descTotal == 0 {
			return 0
		}
		return int32(int64(progress.DescriptionCompletedCount) * 100 / descTotal)
	}

	if filePct < 100 {
		return int32(int64(filePct) * fileBatchProgressWeightStep / totalProgressStepCount)
	}

	if descTotal == 0 {
		return 100
	}
	descPct := int32(int64(progress.DescriptionCompletedCount) * 100 / descTotal)
	return int32(fileBatchProgressWeightStep*100/totalProgressStepCount) + descPct/int32(totalProgressStepCount)
}

func calculateFileBatchProgressPercentage(
	total int64,
	preprocessing int64,
	preprocessed int64,
	extracting int64,
	indexing int64,
	completed int64,
) int32 {
	if total <= 0 {
		return 0
	}

	totalWork := total * fileBatchProgressStepCount
	completedWork := min(preprocessing+
		preprocessed+
		extracting*2+
		indexing*3+
		completed*4, totalWork)

	return int32(completedWork * 100 / totalWork)
}
