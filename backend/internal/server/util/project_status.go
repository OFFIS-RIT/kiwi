package util

func FileProcessingStatusFromBatchStatus(batchStatus string, hasBatchStatus bool) string {
	if !hasBatchStatus {
		return "no_status"
	}

	switch batchStatus {
	case "completed":
		return "processed"
	case "failed":
		return "failed"
	default:
		return "processing"
	}
}
