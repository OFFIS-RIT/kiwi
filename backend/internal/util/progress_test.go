package util

import (
	"testing"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

func TestCalculateBatchProgressPercentage_UsesDurationWhenAvailable(t *testing.T) {
	progress := pgdb.GetProjectFullProgressRow{
		TotalEstimatedDuration:     1000,
		RemainingEstimatedDuration: 250,
	}

	got := CalculateBatchProgressPercentage(progress)
	if got != 75 {
		t.Fatalf("expected 75, got %d", got)
	}
}

func TestCalculateBatchProgressPercentage_FallsBackToStageCounts(t *testing.T) {
	progress := pgdb.GetProjectFullProgressRow{
		BatchTotalCount:         2,
		BatchPreprocessingCount: 1,
		BatchCompletedCount:     1,
	}

	got := CalculateBatchProgressPercentage(progress)
	if got <= 0 || got >= 100 {
		t.Fatalf("expected fallback percentage between 0 and 100, got %d", got)
	}
}

func TestCalculateBatchProgressPercentage_ProcessCapsFilePhaseAtNinety(t *testing.T) {
	progress := pgdb.GetProjectFullProgressRow{
		BatchHasProcessOperation:        true,
		BatchTotalCount:                 3,
		BatchCompletedCount:             3,
		BatchEstimatedDuration:          900,
		BatchRemainingEstimatedDuration: 0,
	}

	got := CalculateBatchProgressPercentage(progress)
	if got != 90 {
		t.Fatalf("expected 90, got %d", got)
	}
}

func TestCalculateBatchProgressPercentage_ProcessDescriptionsFillLastTenPercent(t *testing.T) {
	progress := pgdb.GetProjectFullProgressRow{
		BatchHasProcessOperation:              true,
		BatchTotalCount:                       3,
		BatchCompletedCount:                   3,
		BatchEstimatedDuration:                900,
		BatchRemainingEstimatedDuration:       0,
		DescriptionTotalCount:                 4,
		DescriptionCompletedCount:             2,
		DescriptionEstimatedDuration:          400,
		DescriptionRemainingEstimatedDuration: 200,
	}

	got := CalculateBatchProgressPercentage(progress)
	if got != 95 {
		t.Fatalf("expected 95, got %d", got)
	}
}

func TestCalculateBatchProgressPercentage_DeleteStillReachesHundredAfterFileWork(t *testing.T) {
	progress := pgdb.GetProjectFullProgressRow{
		BatchHasDeleteOperation:         true,
		BatchTotalCount:                 2,
		BatchCompletedCount:             2,
		TotalEstimatedDuration:          600,
		RemainingEstimatedDuration:      0,
		BatchEstimatedDuration:          600,
		BatchRemainingEstimatedDuration: 0,
	}

	got := CalculateBatchProgressPercentage(progress)
	if got != 100 {
		t.Fatalf("expected 100, got %d", got)
	}
}

func TestETAConfidenceFromPrediction(t *testing.T) {
	tests := []struct {
		name          string
		sampleCount   int32
		fallbackLevel int32
		want          string
	}{
		{name: "high confidence", sampleCount: 80, fallbackLevel: 0, want: "high"},
		{name: "medium confidence", sampleCount: 20, fallbackLevel: 1, want: "medium"},
		{name: "low confidence", sampleCount: 2, fallbackLevel: 3, want: "low"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ETAConfidenceFromPrediction(tt.sampleCount, tt.fallbackLevel); got != tt.want {
				t.Fatalf("expected %q, got %q", tt.want, got)
			}
		})
	}
}
