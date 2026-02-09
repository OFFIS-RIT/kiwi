package util

import "testing"

func TestFileProcessingStatusFromBatchStatus(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		batchStatus    string
		hasBatchStatus bool
		want           string
	}{
		{
			name:           "no_batch_status_returns_no_status",
			batchStatus:    "",
			hasBatchStatus: false,
			want:           "no_status",
		},
		{
			name:           "completed_maps_to_processed",
			batchStatus:    "completed",
			hasBatchStatus: true,
			want:           "processed",
		},
		{
			name:           "failed_maps_to_failed",
			batchStatus:    "failed",
			hasBatchStatus: true,
			want:           "failed",
		},
		{
			name:           "pending_maps_to_processing",
			batchStatus:    "pending",
			hasBatchStatus: true,
			want:           "processing",
		},
		{
			name:           "preprocessing_maps_to_processing",
			batchStatus:    "preprocessing",
			hasBatchStatus: true,
			want:           "processing",
		},
		{
			name:           "unknown_status_maps_to_processing",
			batchStatus:    "something_else",
			hasBatchStatus: true,
			want:           "processing",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := FileProcessingStatusFromBatchStatus(tc.batchStatus, tc.hasBatchStatus)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
