package workflow

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"
)

type pauseExecutionError struct{}

func (pauseExecutionError) Error() string {
	return "workflow execution paused"
}

type stepRunOptions struct {
	retryPolicy RetryPolicy
}

// StepOption customizes a durable step.
type StepOption func(*stepRunOptions)

func WithStepRetryPolicy(policy RetryPolicy) StepOption {
	return func(opts *stepRunOptions) {
		opts.retryPolicy = normalizeStepRetryPolicy(&policy)
	}
}

// StepAPI exposes durable step operations during workflow execution.
type StepAPI struct {
	client        *Client
	run           *store.WorkflowRun
	shutdownCh    <-chan struct{}
	mu            sync.Mutex
	stepCounts    map[string]int
	nextStepIndex int
	history       []store.WorkflowStepAttempt
	completed     map[string]store.WorkflowStepAttempt
	failedCurrent map[string][]store.WorkflowStepAttempt
}

func newStepAPI(client *Client, run *store.WorkflowRun, history []store.WorkflowStepAttempt, shutdownCh <-chan struct{}) *StepAPI {
	api := &StepAPI{
		client:        client,
		run:           run,
		shutdownCh:    shutdownCh,
		stepCounts:    make(map[string]int),
		history:       make([]store.WorkflowStepAttempt, 0, len(history)),
		completed:     make(map[string]store.WorkflowStepAttempt),
		failedCurrent: make(map[string][]store.WorkflowStepAttempt),
	}
	for _, attempt := range history {
		api.appendAttemptLocked(attempt)
	}
	return api
}

// Run executes a durable step and memoizes the result.
func (s *StepAPI) Run(ctx context.Context, name string, fn func() (any, error), opts ...StepOption) (any, error) {
	result, _, err := s.RunWithDuration(ctx, name, fn, opts...)
	return result, err
}

// RunWithDuration executes a durable step and returns the recorded duration in milliseconds.
func (s *StepAPI) RunWithDuration(ctx context.Context, name string, fn func() (any, error), opts ...StepOption) (any, int64, error) {
	if err := s.pauseForShutdown(ctx); err != nil {
		return nil, 0, err
	}
	stepName, stepIndex, cached, err := s.prepareStep(name)
	if err != nil {
		return nil, 0, err
	}
	if cached != nil {
		result, err := unmarshalValue(cached.Output)
		return result, stepAttemptDurationMS(*cached), err
	}
	if fn == nil {
		return nil, 0, fmt.Errorf("step %q function is nil", stepName)
	}
	if s.totalAttempts() >= maxTotalStepAttempts {
		return nil, 0, fmt.Errorf("workflow run exceeded %d total step attempts", maxTotalStepAttempts)
	}

	options := stepRunOptions{retryPolicy: DefaultStepRetryPolicy()}
	for _, opt := range opts {
		if opt != nil {
			opt(&options)
		}
	}
	options.retryPolicy = normalizeStepRetryPolicy(&options.retryPolicy)

	currentFailures := s.currentFailedAttempts(stepName)
	attemptNumber := len(currentFailures) + 1
	if len(currentFailures) > 0 {
		lastFailure := currentFailures[len(currentFailures)-1]
		if lastFailure.NextAttemptAt != nil && time.Now().UTC().Before(*lastFailure.NextAttemptAt) {
			if err := s.client.storage.RescheduleWorkflowRun(ctx, store.RescheduleWorkflowRunParams{
				RunID:       s.run.ID,
				WorkerID:    s.run.WorkerID,
				LeaseToken:  s.run.LeaseToken,
				Status:      store.WorkflowRunStateRunning,
				AvailableAt: lastFailure.NextAttemptAt.UTC(),
				WaitReason:  store.WorkflowWaitReasonStepRetry,
			}); err != nil {
				return nil, 0, err
			}
			return nil, 0, pauseExecutionError{}
		}
	}

	result, callErr := invokeWithRecovery(fn)
	completedAt := time.Now().UTC()
	if callErr != nil {
		if !errors.Is(callErr, context.Canceled) && !errors.Is(callErr, context.DeadlineExceeded) && attemptNumber < options.retryPolicy.MaximumAttempts {
			nextAttemptAt := completedAt.Add(nextRetryDelay(options.retryPolicy, attemptNumber))
			attempt, err := s.client.storage.RecordWorkflowStepAttemptAndPark(ctx, store.RecordWorkflowStepAttemptAndParkParams{
				Attempt: store.RecordWorkflowStepAttemptParams{
					RunID:         s.run.ID,
					WorkerID:      s.run.WorkerID,
					LeaseToken:    s.run.LeaseToken,
					RunAttempt:    s.run.AttemptCount,
					StepName:      stepName,
					StepIndex:     stepIndex,
					StepType:      store.WorkflowStepKindRun,
					Status:        store.WorkflowStepAttemptStateFailed,
					Input:         []byte("null"),
					Output:        []byte("null"),
					ErrorMessage:  callErr.Error(),
					AttemptNumber: attemptNumber,
					NextAttemptAt: &nextAttemptAt,
					CompletedAt:   &completedAt,
				},
				RunID:       s.run.ID,
				WorkerID:    s.run.WorkerID,
				LeaseToken:  s.run.LeaseToken,
				AvailableAt: nextAttemptAt,
				WaitReason:  store.WorkflowWaitReasonStepRetry,
			})
			if err != nil {
				return nil, 0, err
			}
			s.appendAttempt(*attempt)
			return nil, stepAttemptDurationMS(*attempt), pauseExecutionError{}
		}

		attempt, err := s.client.storage.RecordWorkflowStepAttempt(ctx, store.RecordWorkflowStepAttemptParams{
			RunID:         s.run.ID,
			WorkerID:      s.run.WorkerID,
			LeaseToken:    s.run.LeaseToken,
			RunAttempt:    s.run.AttemptCount,
			StepName:      stepName,
			StepIndex:     stepIndex,
			StepType:      store.WorkflowStepKindRun,
			Status:        store.WorkflowStepAttemptStateFailed,
			Input:         []byte("null"),
			Output:        []byte("null"),
			ErrorMessage:  callErr.Error(),
			AttemptNumber: attemptNumber,
			CompletedAt:   &completedAt,
		})
		if err != nil {
			return nil, 0, err
		}
		s.appendAttempt(*attempt)
		return nil, stepAttemptDurationMS(*attempt), callErr
	}

	output, err := marshalValue(result)
	if err != nil {
		return nil, 0, fmt.Errorf("marshal step %q output: %w", stepName, err)
	}

	attempt, err := s.client.storage.RecordWorkflowStepAttempt(ctx, store.RecordWorkflowStepAttemptParams{
		RunID:         s.run.ID,
		WorkerID:      s.run.WorkerID,
		LeaseToken:    s.run.LeaseToken,
		RunAttempt:    s.run.AttemptCount,
		StepName:      stepName,
		StepIndex:     stepIndex,
		StepType:      store.WorkflowStepKindRun,
		Status:        store.WorkflowStepAttemptStateCompleted,
		Input:         []byte("null"),
		Output:        output,
		AttemptNumber: attemptNumber,
		CompletedAt:   &completedAt,
	})
	if err != nil {
		return nil, 0, err
	}
	s.appendAttempt(*attempt)
	return result, stepAttemptDurationMS(*attempt), nil
}

// Sleep parks the workflow durably until the duration elapses.
func (s *StepAPI) Sleep(ctx context.Context, name string, duration time.Duration) error {
	if err := s.pauseForShutdown(ctx); err != nil {
		return err
	}
	stepName, stepIndex, cached, err := s.prepareStep(name)
	if err != nil {
		return err
	}
	if cached != nil {
		return nil
	}

	completedAt := time.Now().UTC()
	wakeAt := completedAt.Add(duration)
	if duration <= 0 {
		attempt, err := s.client.storage.RecordWorkflowStepAttempt(ctx, store.RecordWorkflowStepAttemptParams{
			RunID:         s.run.ID,
			WorkerID:      s.run.WorkerID,
			LeaseToken:    s.run.LeaseToken,
			RunAttempt:    s.run.AttemptCount,
			StepName:      stepName,
			StepIndex:     stepIndex,
			StepType:      store.WorkflowStepKindSleep,
			Status:        store.WorkflowStepAttemptStateCompleted,
			Input:         []byte("null"),
			Output:        []byte("null"),
			AttemptNumber: 1,
			SleepUntil:    &completedAt,
			CompletedAt:   &completedAt,
		})
		if err != nil {
			return err
		}
		s.appendAttempt(*attempt)
		return nil
	}

	attempt, err := s.client.storage.RecordWorkflowStepAttemptAndPark(ctx, store.RecordWorkflowStepAttemptAndParkParams{
		Attempt: store.RecordWorkflowStepAttemptParams{
			RunID:         s.run.ID,
			WorkerID:      s.run.WorkerID,
			LeaseToken:    s.run.LeaseToken,
			RunAttempt:    s.run.AttemptCount,
			StepName:      stepName,
			StepIndex:     stepIndex,
			StepType:      store.WorkflowStepKindSleep,
			Status:        store.WorkflowStepAttemptStateCompleted,
			Input:         []byte("null"),
			Output:        []byte("null"),
			AttemptNumber: 1,
			SleepUntil:    &wakeAt,
			CompletedAt:   &completedAt,
		},
		RunID:       s.run.ID,
		WorkerID:    s.run.WorkerID,
		LeaseToken:  s.run.LeaseToken,
		AvailableAt: wakeAt,
		WaitReason:  store.WorkflowWaitReasonSleep,
		SleepUntil:  &wakeAt,
	})
	if err != nil {
		return err
	}
	s.appendAttempt(*attempt)
	return pauseExecutionError{}
}

// RunWorkflow starts a child workflow and waits for its result durably.
func (s *StepAPI) RunWorkflow(ctx context.Context, ref Reference, input any, opts ...RunOption) (any, error) {
	if err := s.pauseForShutdown(ctx); err != nil {
		return nil, err
	}
	stepName, stepIndex, cached, err := s.prepareStep(stepNameFromReference(ref))
	if err != nil {
		return nil, err
	}
	if cached != nil {
		return unmarshalValue(cached.Output)
	}

	if ref == nil {
		return nil, fmt.Errorf("child workflow reference is required")
	}

	childOptions := make([]RunOption, 0, len(opts)+2)
	childOptions = append(childOptions, opts...)
	idempotencyKey := fmt.Sprintf("child:%s:%s", s.run.ID, stepName)
	childOptions = append(childOptions, WithIdempotencyKey(idempotencyKey))
	childOptions = append(childOptions, withParentRun(s.run.ID, stepName, s.rootRunID()))

	childRun, err := s.client.enqueueWorkflowRun(ctx, ref, input, childOptions...)
	if err != nil {
		return nil, err
	}

	spec := ref.GetWorkflowSpec()
	switch childRun.Status {
	case store.WorkflowRunStateCompleted:
		completedAt := time.Now().UTC()
		attempt, err := s.client.storage.RecordWorkflowStepAttempt(ctx, store.RecordWorkflowStepAttemptParams{
			RunID:         s.run.ID,
			WorkerID:      s.run.WorkerID,
			LeaseToken:    s.run.LeaseToken,
			RunAttempt:    s.run.AttemptCount,
			StepName:      stepName,
			StepIndex:     stepIndex,
			StepType:      store.WorkflowStepKindWorkflow,
			Status:        store.WorkflowStepAttemptStateCompleted,
			Input:         childRun.Input,
			Output:        childRun.Output,
			AttemptNumber: 1,
			ChildRunID:    &childRun.ID,
			CompletedAt:   &completedAt,
		})
		if err != nil {
			return nil, err
		}
		s.appendAttempt(*attempt)
		return unmarshalValue(childRun.Output)
	case store.WorkflowRunStateFailed, store.WorkflowRunStateCanceled:
		return nil, &RunError{RunID: childRun.ID, Status: childRun.Status, Message: childRun.ErrorMessage}
	case store.WorkflowRunStatePending, store.WorkflowRunStateRunning:
		now := time.Now().UTC()
		availableAt := now.Add(defaultChildWorkflowPollInterval)
		if childRun.Status == store.WorkflowRunStatePending && childRun.AvailableAt.After(availableAt) {
			availableAt = childRun.AvailableAt.UTC()
		}
		if err := s.client.storage.RescheduleWorkflowRun(ctx, store.RescheduleWorkflowRunParams{
			RunID:       s.run.ID,
			WorkerID:    s.run.WorkerID,
			LeaseToken:  s.run.LeaseToken,
			Status:      store.WorkflowRunStateRunning,
			AvailableAt: availableAt,
			WaitReason:  store.WorkflowWaitReasonChildRun,
		}); err != nil {
			return nil, err
		}
		return nil, pauseExecutionError{}
	default:
		return nil, fmt.Errorf("child workflow %s entered unsupported state %s", describeSpec(spec), childRun.Status)
	}
}

func (s *StepAPI) prepareStep(name string) (string, int, *store.WorkflowStepAttempt, error) {
	resolvedName := name
	if resolvedName == "" {
		return "", 0, nil, fmt.Errorf("step name is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	count := s.stepCounts[resolvedName]
	s.stepCounts[resolvedName] = count + 1
	stepName := resolvedName
	if count > 0 {
		stepName = fmt.Sprintf("%s:%d", resolvedName, count)
	}
	stepIndex := s.nextStepIndex
	s.nextStepIndex++

	if attempt, ok := s.completed[stepName]; ok {
		copied := attempt
		return stepName, stepIndex, &copied, nil
	}

	return stepName, stepIndex, nil, nil
}

func (s *StepAPI) currentFailedAttempts(stepName string) []store.WorkflowStepAttempt {
	s.mu.Lock()
	defer s.mu.Unlock()
	failed := s.failedCurrent[stepName]
	if len(failed) == 0 {
		return nil
	}
	copyOf := make([]store.WorkflowStepAttempt, len(failed))
	copy(copyOf, failed)
	return copyOf
}

func (s *StepAPI) totalAttempts() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.history)
}

func (s *StepAPI) appendAttempt(attempt store.WorkflowStepAttempt) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendAttemptLocked(attempt)
}

func (s *StepAPI) appendAttemptLocked(attempt store.WorkflowStepAttempt) {
	s.history = append(s.history, attempt)
	if attempt.Status == store.WorkflowStepAttemptStateCompleted {
		s.completed[attempt.StepName] = attempt
		delete(s.failedCurrent, attempt.StepName)
		return
	}
	if attempt.RunAttempt == s.run.AttemptCount {
		s.failedCurrent[attempt.StepName] = append(s.failedCurrent[attempt.StepName], attempt)
	}
}

func (s *StepAPI) rootRunID() *string {
	if s.run.RootRunID != nil {
		return s.run.RootRunID
	}
	rootID := s.run.ID
	return &rootID
}

func stepNameFromReference(ref Reference) string {
	if ref == nil {
		return "run-workflow"
	}
	spec := ref.GetWorkflowSpec()
	if spec.Name == "" {
		return "run-workflow"
	}
	return "run-workflow:" + spec.Name
}

func invokeWithRecovery(fn func() (any, error)) (result any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("panic: %v", recovered)
		}
	}()
	return fn()
}

func (s *StepAPI) pauseForShutdown(ctx context.Context) error {
	if s.shutdownCh == nil {
		return nil
	}
	select {
	case <-s.shutdownCh:
		return s.releaseForShutdown(ctx)
	default:
		return nil
	}
}

func (s *StepAPI) releaseForShutdown(ctx context.Context) error {
	if err := s.client.storage.RescheduleWorkflowRun(ctx, store.RescheduleWorkflowRunParams{
		RunID:       s.run.ID,
		WorkerID:    s.run.WorkerID,
		LeaseToken:  s.run.LeaseToken,
		Status:      store.WorkflowRunStateRunning,
		AvailableAt: time.Now().UTC(),
		WaitReason:  store.WorkflowWaitReasonNone,
	}); err != nil {
		return err
	}
	return pauseExecutionError{}
}

func stepAttemptDurationMS(attempt store.WorkflowStepAttempt) int64 {
	if attempt.CompletedAt == nil {
		return 0
	}
	duration := attempt.CompletedAt.Sub(attempt.CreatedAt)
	if duration <= 0 {
		return 0
	}
	return duration.Milliseconds()
}
