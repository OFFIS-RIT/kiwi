package pgx

import (
	"context"
	"errors"
	"time"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	storepkg "github.com/OFFIS-RIT/kiwi/backend/pkg/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

var _ storepkg.WorkflowStorage = (*GraphDBStorage)(nil)

func NewWorkflowDBStorageWithConnection(ctx context.Context, conn pgxIConn) (*GraphDBStorage, error) {
	return NewGraphDBStorageWithConnection(ctx, conn, nil, nil)
}

func (s *GraphDBStorage) CreateWorkflowRun(ctx context.Context, params storepkg.CreateWorkflowRunParams) (*storepkg.WorkflowRun, error) {
	q := pgdb.New(s.conn)
	run, err := q.CreateWorkflowRun(ctx, pgdb.CreateWorkflowRunParams{
		ID:                      params.ID,
		Name:                    params.Name,
		Version:                 params.Version,
		Input:                   params.Input,
		AvailableAt:             toTimestamptz(params.AvailableAt),
		IdempotencyKey:          toText(params.IdempotencyKey),
		ParentRunID:             toText(params.ParentRunID),
		ParentStepName:          toText(params.ParentStepName),
		RootRunID:               toText(params.RootRunID),
		RetryInitialIntervalMs:  params.RetryInitialInterval.Milliseconds(),
		RetryBackoffCoefficient: params.RetryBackoffCoefficient,
		RetryMaximumIntervalMs:  params.RetryMaximumInterval.Milliseconds(),
		RetryMaximumAttempts:    int32(params.RetryMaximumAttempts),
	})
	if err != nil {
		return nil, err
	}
	mapped := mapWorkflowRun(run)
	return &mapped, nil
}

func (s *GraphDBStorage) GetWorkflowRun(ctx context.Context, runID string) (*storepkg.WorkflowRun, error) {
	q := pgdb.New(s.conn)
	run, err := q.GetWorkflowRun(ctx, runID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, storepkg.ErrWorkflowRunNotFound
		}
		return nil, err
	}
	mapped := mapWorkflowRun(run)
	return &mapped, nil
}

func (s *GraphDBStorage) ClaimNextWorkflowRun(ctx context.Context, params storepkg.ClaimWorkflowRunParams) (*storepkg.WorkflowRun, error) {
	q := pgdb.New(s.conn)
	run, err := q.ClaimNextWorkflowRun(ctx, pgdb.ClaimNextWorkflowRunParams{
		WorkerID:    params.WorkerID,
		AvailableAt: toTimestamptz(params.LeaseUntil),
		LeaseToken:  params.LeaseToken,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	mapped := mapWorkflowRun(run)
	return &mapped, nil
}

func (s *GraphDBStorage) HeartbeatWorkflowRun(ctx context.Context, runID, workerID, leaseToken string, leaseUntil time.Time) (bool, error) {
	q := pgdb.New(s.conn)
	rows, err := q.HeartbeatWorkflowRun(ctx, pgdb.HeartbeatWorkflowRunParams{
		ID:          runID,
		WorkerID:    workerID,
		AvailableAt: toTimestamptz(leaseUntil),
		LeaseToken:  leaseToken,
	})
	if err != nil {
		return false, err
	}
	return rows > 0, nil
}

func (s *GraphDBStorage) CompleteWorkflowRun(ctx context.Context, params storepkg.CompleteWorkflowRunParams) error {
	q := pgdb.New(s.conn)
	rows, err := q.CompleteWorkflowRun(ctx, pgdb.CompleteWorkflowRunParams{
		ID:         params.RunID,
		WorkerID:   params.WorkerID,
		LeaseToken: params.LeaseToken,
		Output:     params.Output,
	})
	if err != nil {
		return err
	}
	if rows == 0 {
		return storepkg.ErrWorkflowLeaseLost
	}
	return nil
}

func (s *GraphDBStorage) FailWorkflowRun(ctx context.Context, params storepkg.FailWorkflowRunParams) error {
	q := pgdb.New(s.conn)
	rows, err := q.FailWorkflowRun(ctx, pgdb.FailWorkflowRunParams{
		ID:           params.RunID,
		WorkerID:     params.WorkerID,
		LeaseToken:   params.LeaseToken,
		ErrorMessage: params.ErrorMessage,
	})
	if err != nil {
		return err
	}
	if rows == 0 {
		return storepkg.ErrWorkflowLeaseLost
	}
	return nil
}

func (s *GraphDBStorage) RescheduleWorkflowRun(ctx context.Context, params storepkg.RescheduleWorkflowRunParams) error {
	q := pgdb.New(s.conn)
	rows, err := q.RescheduleWorkflowRun(ctx, pgdb.RescheduleWorkflowRunParams{
		ID:           params.RunID,
		WorkerID:     params.WorkerID,
		LeaseToken:   params.LeaseToken,
		Column3:      string(params.Status),
		AvailableAt:  toTimestamptz(params.AvailableAt),
		ErrorMessage: params.ErrorMessage,
		WaitReason:   string(params.WaitReason),
		SleepUntil:   toOptionalTimestamptz(params.SleepUntil),
	})
	if err != nil {
		return err
	}
	if rows == 0 {
		return storepkg.ErrWorkflowLeaseLost
	}
	return nil
}

func (s *GraphDBStorage) CancelWorkflowRun(ctx context.Context, runID string) error {
	q := pgdb.New(s.conn)
	_, err := q.CancelWorkflowRun(ctx, runID)
	return err
}

func (s *GraphDBStorage) ListWorkflowStepAttempts(ctx context.Context, runID string) ([]storepkg.WorkflowStepAttempt, error) {
	q := pgdb.New(s.conn)
	attempts, err := q.ListWorkflowStepAttempts(ctx, runID)
	if err != nil {
		return nil, err
	}
	result := make([]storepkg.WorkflowStepAttempt, 0, len(attempts))
	for _, attempt := range attempts {
		result = append(result, mapWorkflowStepAttempt(attempt))
	}
	return result, nil
}

func (s *GraphDBStorage) RecordWorkflowStepAttempt(ctx context.Context, params storepkg.RecordWorkflowStepAttemptParams) (*storepkg.WorkflowStepAttempt, error) {
	q := pgdb.New(s.conn)
	attempt, err := q.CreateWorkflowStepAttempt(ctx, pgdb.CreateWorkflowStepAttemptParams{
		ID:            ids.New(),
		RunID:         params.RunID,
		WorkerID:      params.WorkerID,
		LeaseToken:    params.LeaseToken,
		RunAttempt:    int32(params.RunAttempt),
		StepName:      params.StepName,
		StepIndex:     int32(params.StepIndex),
		StepType:      string(params.StepType),
		Status:        string(params.Status),
		Input:         params.Input,
		Output:        params.Output,
		ErrorMessage:  params.ErrorMessage,
		AttemptNumber: int32(params.AttemptNumber),
		NextAttemptAt: toOptionalTimestamptz(params.NextAttemptAt),
		SleepUntil:    toOptionalTimestamptz(params.SleepUntil),
		ChildRunID:    toText(params.ChildRunID),
		CompletedAt:   toOptionalTimestamptz(params.CompletedAt),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, storepkg.ErrWorkflowLeaseLost
		}
		return nil, err
	}
	mapped := mapWorkflowStepAttempt(attempt)
	return &mapped, nil
}

func (s *GraphDBStorage) RecordWorkflowStepAttemptAndPark(ctx context.Context, params storepkg.RecordWorkflowStepAttemptAndParkParams) (*storepkg.WorkflowStepAttempt, error) {
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	q := pgdb.New(tx)
	attempt, err := q.CreateWorkflowStepAttempt(ctx, pgdb.CreateWorkflowStepAttemptParams{
		ID:            ids.New(),
		RunID:         params.Attempt.RunID,
		WorkerID:      params.Attempt.WorkerID,
		LeaseToken:    params.Attempt.LeaseToken,
		RunAttempt:    int32(params.Attempt.RunAttempt),
		StepName:      params.Attempt.StepName,
		StepIndex:     int32(params.Attempt.StepIndex),
		StepType:      string(params.Attempt.StepType),
		Status:        string(params.Attempt.Status),
		Input:         params.Attempt.Input,
		Output:        params.Attempt.Output,
		ErrorMessage:  params.Attempt.ErrorMessage,
		AttemptNumber: int32(params.Attempt.AttemptNumber),
		NextAttemptAt: toOptionalTimestamptz(params.Attempt.NextAttemptAt),
		SleepUntil:    toOptionalTimestamptz(params.Attempt.SleepUntil),
		ChildRunID:    toText(params.Attempt.ChildRunID),
		CompletedAt:   toOptionalTimestamptz(params.Attempt.CompletedAt),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, storepkg.ErrWorkflowLeaseLost
		}
		return nil, err
	}

	rows, err := q.RescheduleWorkflowRun(ctx, pgdb.RescheduleWorkflowRunParams{
		ID:           params.RunID,
		WorkerID:     params.WorkerID,
		LeaseToken:   params.LeaseToken,
		Column3:      string(storepkg.WorkflowRunStateRunning),
		AvailableAt:  toTimestamptz(params.AvailableAt),
		ErrorMessage: "",
		WaitReason:   string(params.WaitReason),
		SleepUntil:   toOptionalTimestamptz(params.SleepUntil),
	})
	if err != nil {
		return nil, err
	}
	if rows == 0 {
		return nil, storepkg.ErrWorkflowLeaseLost
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	mapped := mapWorkflowStepAttempt(attempt)
	return &mapped, nil
}

func mapWorkflowRun(run pgdb.WorkflowRun) storepkg.WorkflowRun {
	return storepkg.WorkflowRun{
		ID:                      run.ID,
		Name:                    run.Name,
		Version:                 run.Version,
		Input:                   run.Input,
		Output:                  run.Output,
		Status:                  storepkg.WorkflowRunState(run.Status),
		ErrorMessage:            run.ErrorMessage,
		AttemptCount:            int(run.AttemptCount),
		AvailableAt:             run.AvailableAt.Time.UTC(),
		WorkerID:                run.WorkerID,
		LeaseToken:              run.LeaseToken,
		WaitReason:              storepkg.WorkflowWaitReason(run.WaitReason),
		SleepUntil:              timestamptzPtr(run.SleepUntil),
		IdempotencyKey:          textPtr(run.IdempotencyKey),
		ParentRunID:             textPtr(run.ParentRunID),
		ParentStepName:          textPtr(run.ParentStepName),
		RootRunID:               textPtr(run.RootRunID),
		RetryInitialInterval:    time.Duration(run.RetryInitialIntervalMs) * time.Millisecond,
		RetryBackoffCoefficient: run.RetryBackoffCoefficient,
		RetryMaximumInterval:    time.Duration(run.RetryMaximumIntervalMs) * time.Millisecond,
		RetryMaximumAttempts:    int(run.RetryMaximumAttempts),
		CreatedAt:               run.CreatedAt.Time.UTC(),
		UpdatedAt:               run.UpdatedAt.Time.UTC(),
		LastHeartbeatAt:         run.LastHeartbeatAt.Time.UTC(),
	}
}

func mapWorkflowStepAttempt(attempt pgdb.WorkflowStepAttempt) storepkg.WorkflowStepAttempt {
	return storepkg.WorkflowStepAttempt{
		ID:            attempt.ID,
		RunID:         attempt.RunID,
		RunAttempt:    int(attempt.RunAttempt),
		StepName:      attempt.StepName,
		StepIndex:     int(attempt.StepIndex),
		StepType:      storepkg.WorkflowStepKind(attempt.StepType),
		Status:        storepkg.WorkflowStepAttemptState(attempt.Status),
		Input:         attempt.Input,
		Output:        attempt.Output,
		ErrorMessage:  attempt.ErrorMessage,
		AttemptNumber: int(attempt.AttemptNumber),
		NextAttemptAt: timestamptzPtr(attempt.NextAttemptAt),
		SleepUntil:    timestamptzPtr(attempt.SleepUntil),
		ChildRunID:    textPtr(attempt.ChildRunID),
		CreatedAt:     attempt.CreatedAt.Time.UTC(),
		CompletedAt:   timestamptzPtr(attempt.CompletedAt),
	}
}

func toText(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func textPtr(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	v := value.String
	return &v
}

func toTimestamptz(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func toOptionalTimestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func timestamptzPtr(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time.UTC()
	return &v
}
