package workflow

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"
)

const (
	defaultWorkerConcurrency       = 1
	defaultWorkerPollInterval      = 500 * time.Millisecond
	defaultWorkerLeaseDuration     = 30 * time.Second
	defaultWorkerHeartbeatInterval = 10 * time.Second
)

// Worker executes durable workflow runs.
type Worker struct {
	client            *Client
	workerID          string
	concurrency       int
	pollInterval      time.Duration
	leaseDuration     time.Duration
	heartbeatInterval time.Duration
	terminalFailure   func(ctx context.Context, run *RunInfo, err error)
}

type RunInfo struct {
	ID      string
	Name    string
	Version string
	Input   []byte
}

type WorkerOption func(*Worker)

func WithWorkerID(workerID string) WorkerOption {
	return func(worker *Worker) {
		worker.workerID = workerID
	}
}

func WithConcurrency(concurrency int) WorkerOption {
	return func(worker *Worker) {
		worker.concurrency = concurrency
	}
}

func WithPollInterval(interval time.Duration) WorkerOption {
	return func(worker *Worker) {
		worker.pollInterval = interval
	}
}

func WithLeaseDuration(duration time.Duration) WorkerOption {
	return func(worker *Worker) {
		worker.leaseDuration = duration
	}
}

func WithHeartbeatInterval(interval time.Duration) WorkerOption {
	return func(worker *Worker) {
		worker.heartbeatInterval = interval
	}
}

func WithTerminalFailureHandler(handler func(ctx context.Context, run *RunInfo, err error)) WorkerOption {
	return func(worker *Worker) {
		worker.terminalFailure = handler
	}
}

func newWorker(client *Client, opts ...WorkerOption) *Worker {
	workerID := ids.New()

	worker := &Worker{
		client:            client,
		workerID:          workerID,
		concurrency:       defaultWorkerConcurrency,
		pollInterval:      defaultWorkerPollInterval,
		leaseDuration:     defaultWorkerLeaseDuration,
		heartbeatInterval: defaultWorkerHeartbeatInterval,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(worker)
		}
	}
	if worker.concurrency <= 0 {
		worker.concurrency = defaultWorkerConcurrency
	}
	if worker.pollInterval <= 0 {
		worker.pollInterval = defaultWorkerPollInterval
	}
	if worker.leaseDuration <= 0 {
		worker.leaseDuration = defaultWorkerLeaseDuration
	}
	if worker.heartbeatInterval <= 0 || worker.heartbeatInterval >= worker.leaseDuration {
		worker.heartbeatInterval = worker.leaseDuration / 3
		if worker.heartbeatInterval <= 0 {
			worker.heartbeatInterval = time.Second
		}
	}
	return worker
}

func (w *Worker) Start(ctx context.Context) error {
	var wg sync.WaitGroup
	for i := 0; i < w.concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.loop(ctx)
		}()
	}
	wg.Wait()
	return nil
}

func (w *Worker) loop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		run, err := w.client.storage.ClaimNextWorkflowRun(ctx, store.ClaimWorkflowRunParams{
			WorkerID:   w.workerID,
			LeaseUntil: time.Now().UTC().Add(w.leaseDuration),
			LeaseToken: newLeaseToken(),
		})
		if err != nil {
			if !sleepUntilNextPoll(ctx, w.pollInterval) {
				return
			}
			continue
		}
		if run == nil {
			if !sleepUntilNextPoll(ctx, w.pollInterval) {
				return
			}
			continue
		}

		w.execute(ctx, run)
	}
}

func (w *Worker) execute(shutdownCtx context.Context, run *store.WorkflowRun) {
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stopHeartbeat := make(chan struct{})
	var heartbeatWG sync.WaitGroup
	heartbeatWG.Add(1)
	go func() {
		defer heartbeatWG.Done()
		w.heartbeatLoop(runCtx, run, cancel, stopHeartbeat)
	}()

	result, err := w.executeRun(runCtx, shutdownCtx, run)
	close(stopHeartbeat)
	heartbeatWG.Wait()

	if err != nil {
		var paused pauseExecutionError
		if errors.As(err, &paused) {
			return
		}
		if errors.Is(err, store.ErrWorkflowLeaseLost) {
			return
		}
		w.finishWithError(run, err)
		return
	}

	output, marshalErr := marshalValue(result)
	if marshalErr != nil {
		w.finishWithError(run, fmt.Errorf("marshal workflow output: %w", marshalErr))
		return
	}

	if err := w.client.storage.CompleteWorkflowRun(context.Background(), store.CompleteWorkflowRunParams{
		RunID:      run.ID,
		WorkerID:   w.workerID,
		LeaseToken: run.LeaseToken,
		Output:     output,
	}); err != nil && !errors.Is(err, store.ErrWorkflowLeaseLost) {
		w.finishWithError(run, err)
	}
}

func (w *Worker) executeRun(ctx context.Context, shutdownCtx context.Context, run *store.WorkflowRun) (any, error) {
	history, err := w.client.storage.ListWorkflowStepAttempts(ctx, run.ID)
	if err != nil {
		return nil, err
	}

	workflowDef, ok := w.client.registry.Lookup(WorkflowSpec{Name: run.Name, Version: run.Version})
	if !ok {
		return nil, missingWorkflowError{Spec: WorkflowSpec{Name: run.Name, Version: run.Version}}
	}

	input, err := unmarshalValue(run.Input)
	if err != nil {
		return nil, fmt.Errorf("unmarshal workflow input: %w", err)
	}

	step := newStepAPI(w.client, run, history, shutdownCtx.Done())
	return callWorkflowHandler(ctx, workflowDef.Handler, input, step)
}

func (w *Worker) heartbeatLoop(ctx context.Context, run *store.WorkflowRun, cancel context.CancelFunc, stop <-chan struct{}) {
	ticker := time.NewTicker(w.heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			ok, err := w.client.storage.HeartbeatWorkflowRun(context.Background(), run.ID, w.workerID, run.LeaseToken, time.Now().UTC().Add(w.leaseDuration))
			if err != nil || !ok {
				cancel()
				return
			}
		}
	}
}

func (w *Worker) finishWithError(run *store.WorkflowRun, err error) {
	policy := retryPolicyFromRun(run)
	message := err.Error()
	reason := store.WorkflowWaitReasonRunRetry
	if _, ok := err.(missingWorkflowError); ok {
		reason = store.WorkflowWaitReasonMissingImpl
	}

	if run.AttemptCount < policy.MaximumAttempts {
		nextAt := time.Now().UTC().Add(nextRetryDelay(policy, run.AttemptCount))
		rescheduleErr := w.client.storage.RescheduleWorkflowRun(context.Background(), store.RescheduleWorkflowRunParams{
			RunID:        run.ID,
			WorkerID:     w.workerID,
			LeaseToken:   run.LeaseToken,
			Status:       store.WorkflowRunStatePending,
			AvailableAt:  nextAt,
			ErrorMessage: message,
			WaitReason:   reason,
		})
		if rescheduleErr == nil || errors.Is(rescheduleErr, store.ErrWorkflowLeaseLost) {
			return
		}
		message = fmt.Sprintf("%s; reschedule failed: %v", message, rescheduleErr)
	}

	_ = w.client.storage.FailWorkflowRun(context.Background(), store.FailWorkflowRunParams{
		RunID:        run.ID,
		WorkerID:     w.workerID,
		LeaseToken:   run.LeaseToken,
		ErrorMessage: message,
	})

	if w.terminalFailure != nil {
		w.terminalFailure(context.Background(), &RunInfo{
			ID:      run.ID,
			Name:    run.Name,
			Version: run.Version,
			Input:   append([]byte(nil), run.Input...),
		}, err)
	}
}

func newLeaseToken() string {
	return ids.New()
}

func retryPolicyFromRun(run *store.WorkflowRun) RetryPolicy {
	policy := RetryPolicy{
		InitialInterval:    run.RetryInitialInterval,
		BackoffCoefficient: run.RetryBackoffCoefficient,
		MaximumInterval:    run.RetryMaximumInterval,
		MaximumAttempts:    run.RetryMaximumAttempts,
	}
	return normalizeWorkflowRetryPolicy(&policy)
}

func callWorkflowHandler(ctx context.Context, handler WorkflowFunc, input any, step *StepAPI) (result any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("workflow panic: %v", recovered)
		}
	}()
	return handler(ctx, input, step)
}

type missingWorkflowError struct {
	Spec WorkflowSpec
}

func (e missingWorkflowError) Error() string {
	return fmt.Sprintf("no workflow implementation registered for %s", describeSpec(e.Spec))
}

func sleepUntilNextPoll(ctx context.Context, interval time.Duration) bool {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
