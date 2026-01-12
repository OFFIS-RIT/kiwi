package base

import (
	"context"

	"kiwi/internal/db"
)

// UpdateProjectProcessStep updates the current step of project processing.
// This does NOT update updated_at, so time remaining calculation is not affected.
// Use this for sub-step updates (extraction, generating_descriptions, saving).
func (s *GraphDBStorage) UpdateProjectProcessStep(ctx context.Context, projectID int64, step string) error {
	q := db.New(s.conn)
	return q.UpdateProjectProcessStepOnly(ctx, db.UpdateProjectProcessStepOnlyParams{
		ProjectID:   projectID,
		CurrentStep: step,
	})
}

// UpdateProjectProcessPercentage updates the progress percentage.
func (s *GraphDBStorage) UpdateProjectProcessPercentage(ctx context.Context, projectID int64, percentage int32) error {
	q := db.New(s.conn)
	return q.UpdateProjectProcessPercentage(ctx, db.UpdateProjectProcessPercentageParams{
		ProjectID:  projectID,
		Percentage: percentage,
	})
}
