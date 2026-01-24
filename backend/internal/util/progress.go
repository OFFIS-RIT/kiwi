package util

import (
	"fmt"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
)

type BatchStepProgress struct {
	Pending       string `json:"pending,omitempty"`
	Preprocessing string `json:"preprocessing,omitempty"`
	Preprocessed  string `json:"preprocessed,omitempty"`
	Extracting    string `json:"extracting,omitempty"`
	Indexing      string `json:"indexing,omitempty"`
	Completed     string `json:"completed,omitempty"`
	Failed        string `json:"failed,omitempty"`
}

type BatchProgress struct {
	Step              *BatchStepProgress
	Percentage        *int32
	EstimatedDuration *int64
	TimeRemaining     *int64
}

const batchProgressStepCount int64 = 4

func BuildBatchProgress(progress db.GetProjectBatchProgressRow) BatchProgress {
	if progress.TotalCount <= 0 {
		return BatchProgress{}
	}

	total := progress.TotalCount
	stepProgress := BatchStepProgress{}
	hasStep := false

	if progress.PendingCount > 0 {
		stepProgress.Pending = fmt.Sprintf("%d/%d", progress.PendingCount, total)
		hasStep = true
	}
	if progress.PreprocessingCount > 0 {
		stepProgress.Preprocessing = fmt.Sprintf("%d/%d", progress.PreprocessingCount, total)
		hasStep = true
	}
	if progress.PreprocessedCount > 0 {
		stepProgress.Preprocessed = fmt.Sprintf("%d/%d", progress.PreprocessedCount, total)
		hasStep = true
	}
	if progress.ExtractingCount > 0 {
		stepProgress.Extracting = fmt.Sprintf("%d/%d", progress.ExtractingCount, total)
		hasStep = true
	}
	if progress.IndexingCount > 0 {
		stepProgress.Indexing = fmt.Sprintf("%d/%d", progress.IndexingCount, total)
		hasStep = true
	}
	if progress.CompletedCount > 0 {
		stepProgress.Completed = fmt.Sprintf("%d/%d", progress.CompletedCount, total)
		hasStep = true
	}
	if progress.FailedCount > 0 {
		stepProgress.Failed = fmt.Sprintf("%d/%d", progress.FailedCount, total)
		hasStep = true
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

func CalculateBatchProgressPercentage(progress db.GetProjectBatchProgressRow) int32 {
	total := int64(progress.TotalCount)
	if total <= 0 {
		return 0
	}

	totalWork := total * batchProgressStepCount
	// Weight phases cumulatively so progress only hits 100% at completed.
	// Steps: preprocessing=1, extracting=2, indexing=3, completed=4.
	completedWork := min(int64(progress.PreprocessingCount)+
		int64(progress.PreprocessedCount)+
		int64(progress.ExtractingCount)*2+
		int64(progress.IndexingCount)*3+
		int64(progress.CompletedCount)*4, totalWork)

	return int32(completedWork * 100 / totalWork)
}
