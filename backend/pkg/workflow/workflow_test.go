package workflow

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"
)

func TestWorker_StepRetryResumesSameRunAttempt(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	client, err := NewClient(WithStorage(storage))
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	var calls int
	workflow := MustDefineWorkflow(
		WorkflowSpec{Name: "step-retry"},
		func(ctx context.Context, input any, step *StepAPI) (any, error) {
			result, err := step.Run(ctx, "unstable", func() (any, error) {
				calls++
				if calls == 1 {
					return nil, fmt.Errorf("boom")
				}
				return "ok", nil
			}, WithStepRetryPolicy(RetryPolicy{
				InitialInterval:    10 * time.Millisecond,
				BackoffCoefficient: 1,
				MaximumInterval:    10 * time.Millisecond,
				MaximumAttempts:    2,
			}))
			if err != nil {
				return nil, err
			}
			return result, nil
		},
	)
	if err := client.ImplementWorkflow(workflow); err != nil {
		t.Fatalf("implement workflow: %v", err)
	}

	ctx, cancel, done := startTestWorker(client, WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond))
	defer func() {
		cancel()
		<-done
	}()

	handle, err := client.RunWorkflow(context.Background(), workflow, map[string]any{"id": 1})
	if err != nil {
		t.Fatalf("run workflow: %v", err)
	}

	result, err := handle.Result(withTimeout(t, time.Second))
	if err != nil {
		t.Fatalf("handle result: %v", err)
	}
	if result.(string) != "ok" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if calls != 2 {
		t.Fatalf("expected 2 step calls, got %d", calls)
	}

	run, err := storage.GetWorkflowRun(context.Background(), handle.ID())
	if err != nil {
		t.Fatalf("get workflow run: %v", err)
	}
	if run.AttemptCount != 1 {
		t.Fatalf("expected run attempt count 1, got %d", run.AttemptCount)
	}
	attempts, err := storage.ListWorkflowStepAttempts(context.Background(), handle.ID())
	if err != nil {
		t.Fatalf("list step attempts: %v", err)
	}
	if len(attempts) != 2 {
		t.Fatalf("expected 2 step attempts, got %d", len(attempts))
	}
	_ = ctx
}

func TestWorker_WorkflowRetryReplaysCompletedSteps(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	client, err := NewClient(WithStorage(storage))
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	var fetchCalls int
	var processCalls int
	workflow := MustDefineWorkflow(
		WorkflowSpec{Name: "workflow-retry"},
		func(ctx context.Context, input any, step *StepAPI) (any, error) {
			_, err := step.Run(ctx, "fetch-user", func() (any, error) {
				fetchCalls++
				return map[string]any{"name": "Kiwi"}, nil
			})
			if err != nil {
				return nil, err
			}

			_, err = step.Run(ctx, "process-user", func() (any, error) {
				processCalls++
				if processCalls == 1 {
					return nil, fmt.Errorf("transient failure")
				}
				return map[string]any{"processed": true}, nil
			})
			if err != nil {
				return nil, err
			}

			return "done", nil
		},
		WithWorkflowRetryPolicy(RetryPolicy{
			InitialInterval:    10 * time.Millisecond,
			BackoffCoefficient: 1,
			MaximumInterval:    10 * time.Millisecond,
			MaximumAttempts:    2,
		}),
	)
	if err := client.ImplementWorkflow(workflow); err != nil {
		t.Fatalf("implement workflow: %v", err)
	}

	_, cancel, done := startTestWorker(client, WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond))
	defer func() {
		cancel()
		<-done
	}()

	handle, err := client.RunWorkflow(context.Background(), workflow, nil)
	if err != nil {
		t.Fatalf("run workflow: %v", err)
	}

	result, err := handle.Result(withTimeout(t, time.Second))
	if err != nil {
		t.Fatalf("handle result: %v", err)
	}
	if result.(string) != "done" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if fetchCalls != 1 {
		t.Fatalf("expected fetch step to run once, got %d", fetchCalls)
	}
	if processCalls != 2 {
		t.Fatalf("expected process step to run twice, got %d", processCalls)
	}

	run, err := storage.GetWorkflowRun(context.Background(), handle.ID())
	if err != nil {
		t.Fatalf("get workflow run: %v", err)
	}
	if run.AttemptCount != 2 {
		t.Fatalf("expected run attempt count 2, got %d", run.AttemptCount)
	}
}

func TestClaimNextWorkflowRun_ReclaimIncrementsAttemptCount(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	run, err := storage.CreateWorkflowRun(context.Background(), store.CreateWorkflowRunParams{
		ID:                      "reclaim-run",
		Name:                    "reclaim",
		Version:                 "v1",
		Input:                   []byte("null"),
		AvailableAt:             time.Now().Add(-time.Minute),
		RetryBackoffCoefficient: 1,
	})
	if err != nil {
		t.Fatalf("create workflow run: %v", err)
	}

	storage.mu.Lock()
	stored := storage.runs[run.ID]
	stored.Status = store.WorkflowRunStateRunning
	stored.WaitReason = store.WorkflowWaitReasonNone
	stored.WorkerID = "stale-worker"
	stored.LeaseToken = "stale-lease"
	stored.AttemptCount = 1
	stored.AvailableAt = time.Now().Add(-time.Second)
	storage.mu.Unlock()

	claimed, err := storage.ClaimNextWorkflowRun(context.Background(), store.ClaimWorkflowRunParams{
		WorkerID:   "worker-2",
		LeaseToken: "lease-2",
		LeaseUntil: time.Now().Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("claim workflow run: %v", err)
	}
	if claimed == nil {
		t.Fatal("expected reclaimed workflow run")
	}
	if claimed.AttemptCount != 2 {
		t.Fatalf("expected reclaimed run attempt count 2, got %d", claimed.AttemptCount)
	}
}

func TestWorker_SleepParksAndResumesWorkflow(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	client, err := NewClient(WithStorage(storage))
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	var beforeSleep int
	var afterSleep int
	workflow := MustDefineWorkflow(
		WorkflowSpec{Name: "sleep"},
		func(ctx context.Context, input any, step *StepAPI) (any, error) {
			_, err := step.Run(ctx, "before-sleep", func() (any, error) {
				beforeSleep++
				return nil, nil
			})
			if err != nil {
				return nil, err
			}

			if err := step.Sleep(ctx, "wait", 40*time.Millisecond); err != nil {
				return nil, err
			}

			_, err = step.Run(ctx, "after-sleep", func() (any, error) {
				afterSleep++
				return nil, nil
			})
			if err != nil {
				return nil, err
			}

			return "awake", nil
		},
	)
	if err := client.ImplementWorkflow(workflow); err != nil {
		t.Fatalf("implement workflow: %v", err)
	}

	_, cancel, done := startTestWorker(client, WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond))
	defer func() {
		cancel()
		<-done
	}()

	handle, err := client.RunWorkflow(context.Background(), workflow, nil)
	if err != nil {
		t.Fatalf("run workflow: %v", err)
	}

	waitFor(t, 200*time.Millisecond, func() bool {
		run, getErr := storage.GetWorkflowRun(context.Background(), handle.ID())
		if getErr != nil {
			return false
		}
		return run.WaitReason == store.WorkflowWaitReasonSleep
	})
	if afterSleep != 0 {
		t.Fatalf("expected post-sleep step to wait, got %d", afterSleep)
	}

	result, err := handle.Result(withTimeout(t, time.Second))
	if err != nil {
		t.Fatalf("handle result: %v", err)
	}
	if result.(string) != "awake" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if beforeSleep != 1 || afterSleep != 1 {
		t.Fatalf("expected sleep workflow to run once before and after sleep, got before=%d after=%d", beforeSleep, afterSleep)
	}
}

func TestWorker_ChildWorkflowCompletesDurably(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	client, err := NewClient(WithStorage(storage))
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	var childCalls int
	child := MustDefineWorkflow(
		WorkflowSpec{Name: "child", Version: "v1"},
		func(ctx context.Context, input any, step *StepAPI) (any, error) {
			result, err := step.Run(ctx, "child-step", func() (any, error) {
				childCalls++
				return map[string]any{"child": true}, nil
			})
			if err != nil {
				return nil, err
			}
			return result, nil
		},
	)
	parent := MustDefineWorkflow(
		WorkflowSpec{Name: "parent", Version: "v1"},
		func(ctx context.Context, input any, step *StepAPI) (any, error) {
			return step.RunWorkflow(ctx, child, map[string]any{"hello": "world"})
		},
	)
	if err := client.ImplementWorkflow(child); err != nil {
		t.Fatalf("implement child: %v", err)
	}
	if err := client.ImplementWorkflow(parent); err != nil {
		t.Fatalf("implement parent: %v", err)
	}

	_, cancel, done := startTestWorker(client, WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond))
	defer func() {
		cancel()
		<-done
	}()

	handle, err := client.RunWorkflow(context.Background(), parent, nil)
	if err != nil {
		t.Fatalf("run parent workflow: %v", err)
	}

	result, err := handle.Result(withTimeout(t, time.Second))
	if err != nil {
		t.Fatalf("handle result: %v", err)
	}
	resultMap := result.(map[string]any)
	if resultMap["child"] != true {
		t.Fatalf("unexpected child result: %#v", result)
	}
	if childCalls != 1 {
		t.Fatalf("expected child step to run once, got %d", childCalls)
	}
	if storage.runCountByName("child", "v1") != 1 {
		t.Fatalf("expected one child workflow run")
	}
}

func TestWorker_MissingWorkflowReschedulesUntilImplementationExists(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	client, err := NewClient(WithStorage(storage))
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	_, cancel, done := startTestWorker(client, WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond))
	defer func() {
		cancel()
		<-done
	}()

	spec := WorkflowSpec{Name: "late-workflow", Version: "2026"}
	handle, err := client.RunWorkflow(context.Background(), spec, nil, WithRunRetryPolicy(RetryPolicy{
		InitialInterval:    10 * time.Millisecond,
		BackoffCoefficient: 1,
		MaximumInterval:    10 * time.Millisecond,
		MaximumAttempts:    3,
	}))
	if err != nil {
		t.Fatalf("run workflow: %v", err)
	}

	waitFor(t, 200*time.Millisecond, func() bool {
		run, getErr := storage.GetWorkflowRun(context.Background(), handle.ID())
		if getErr != nil {
			return false
		}
		return run.Status == store.WorkflowRunStatePending && strings.Contains(run.ErrorMessage, "no workflow implementation registered")
	})

	workflow := MustDefineWorkflow(spec, func(ctx context.Context, input any, step *StepAPI) (any, error) {
		return "ready", nil
	})
	if err := client.ImplementWorkflow(workflow); err != nil {
		t.Fatalf("implement workflow: %v", err)
	}

	result, err := handle.Result(withTimeout(t, time.Second))
	if err != nil {
		t.Fatalf("handle result: %v", err)
	}
	if result.(string) != "ready" {
		t.Fatalf("unexpected result: %#v", result)
	}

	run, err := storage.GetWorkflowRun(context.Background(), handle.ID())
	if err != nil {
		t.Fatalf("get workflow run: %v", err)
	}
	if run.AttemptCount < 2 {
		t.Fatalf("expected missing implementation to trigger another workflow attempt, got %d", run.AttemptCount)
	}
}

func TestWorker_HeartbeatsLongRunningStep(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	client, err := NewClient(WithStorage(storage))
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	workflow := MustDefineWorkflow(
		WorkflowSpec{Name: "heartbeat"},
		func(ctx context.Context, input any, step *StepAPI) (any, error) {
			_, err := step.Run(ctx, "slow", func() (any, error) {
				time.Sleep(120 * time.Millisecond)
				return nil, nil
			})
			if err != nil {
				return nil, err
			}
			return "ok", nil
		},
	)
	if err := client.ImplementWorkflow(workflow); err != nil {
		t.Fatalf("implement workflow: %v", err)
	}

	_, cancel, done := startTestWorker(client, WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond))
	defer func() {
		cancel()
		<-done
	}()

	handle, err := client.RunWorkflow(context.Background(), workflow, nil)
	if err != nil {
		t.Fatalf("run workflow: %v", err)
	}

	if _, err := handle.Result(withTimeout(t, time.Second)); err != nil {
		t.Fatalf("handle result: %v", err)
	}
	if storage.heartbeatCount() == 0 {
		t.Fatalf("expected at least one heartbeat during long-running step")
	}
}

func TestWorker_ParallelStepsWithUniqueNames(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	client, err := NewClient(WithStorage(storage))
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	counts := map[string]int{}
	var countsMu sync.Mutex
	workflow := MustDefineWorkflow(
		WorkflowSpec{Name: "parallel"},
		func(ctx context.Context, input any, step *StepAPI) (any, error) {
			var wg sync.WaitGroup
			errs := make(chan error, 3)
			for _, name := range []string{"a", "b", "c"} {
				stepName := name
				wg.Add(1)
				go func() {
					defer wg.Done()
					_, err := step.Run(ctx, stepName, func() (any, error) {
						countsMu.Lock()
						counts[stepName]++
						countsMu.Unlock()
						return stepName, nil
					})
					errs <- err
				}()
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					return nil, err
				}
			}
			return "ok", nil
		},
	)
	if err := client.ImplementWorkflow(workflow); err != nil {
		t.Fatalf("implement workflow: %v", err)
	}

	_, cancel, done := startTestWorker(client, WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond))
	defer func() {
		cancel()
		<-done
	}()

	handle, err := client.RunWorkflow(context.Background(), workflow, nil)
	if err != nil {
		t.Fatalf("run workflow: %v", err)
	}

	if _, err := handle.Result(withTimeout(t, time.Second)); err != nil {
		t.Fatalf("handle result: %v", err)
	}

	for _, name := range []string{"a", "b", "c"} {
		if counts[name] != 1 {
			t.Fatalf("expected step %s to run once, got %d", name, counts[name])
		}
	}
	attempts, err := storage.ListWorkflowStepAttempts(context.Background(), handle.ID())
	if err != nil {
		t.Fatalf("list step attempts: %v", err)
	}
	if len(attempts) != 3 {
		t.Fatalf("expected 3 step attempts, got %d", len(attempts))
	}
}

func TestWorker_ShutdownFinishesCurrentStepAndReleasesRun(t *testing.T) {
	t.Parallel()

	storage := newMemoryWorkflowStorage()
	client, err := NewClient(WithStorage(storage))
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	var afterCount int
	workflow := MustDefineWorkflow(
		WorkflowSpec{Name: "shutdown"},
		func(ctx context.Context, input any, step *StepAPI) (any, error) {
			_, err := step.Run(ctx, "long-step", func() (any, error) {
				close(started)
				<-release
				return "done", nil
			})
			if err != nil {
				return nil, err
			}

			_, err = step.Run(ctx, "after-shutdown", func() (any, error) {
				afterCount++
				return nil, nil
			})
			if err != nil {
				return nil, err
			}
			return "complete", nil
		},
	)
	if err := client.ImplementWorkflow(workflow); err != nil {
		t.Fatalf("implement workflow: %v", err)
	}

	workerCtx, cancelWorker := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- client.NewWorker(WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond)).Start(workerCtx)
	}()

	handle, err := client.RunWorkflow(context.Background(), workflow, nil)
	if err != nil {
		t.Fatalf("run workflow: %v", err)
	}

	<-started
	cancelWorker()
	close(release)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("worker exit: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not stop after shutdown")
	}

	if afterCount != 0 {
		t.Fatalf("expected no new steps after shutdown, got %d", afterCount)
	}

	run, err := storage.GetWorkflowRun(context.Background(), handle.ID())
	if err != nil {
		t.Fatalf("get workflow run: %v", err)
	}
	if run.Status != store.WorkflowRunStateRunning {
		t.Fatalf("expected run to be released in running state, got %s", run.Status)
	}
	if run.WorkerID != "" {
		t.Fatalf("expected worker lease to be released")
	}

	_, cancel, restartedDone := startTestWorker(client, WithPollInterval(5*time.Millisecond), WithLeaseDuration(60*time.Millisecond), WithHeartbeatInterval(20*time.Millisecond))
	defer func() {
		cancel()
		<-restartedDone
	}()

	result, err := handle.Result(withTimeout(t, time.Second))
	if err != nil {
		t.Fatalf("handle result: %v", err)
	}
	if result.(string) != "complete" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if afterCount != 1 {
		t.Fatalf("expected resumed worker to finish remaining step once, got %d", afterCount)
	}
}

func startTestWorker(client *Client, opts ...WorkerOption) (context.Context, context.CancelFunc, <-chan error) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- client.NewWorker(opts...).Start(ctx)
	}()
	return ctx, cancel, done
}

func withTimeout(t *testing.T, timeout time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	t.Cleanup(cancel)
	return ctx
}

func waitFor(t *testing.T, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

type memoryWorkflowStorage struct {
	mu            sync.Mutex
	runs          map[string]*store.WorkflowRun
	idempotency   map[string]string
	stepAttempts  map[string][]store.WorkflowStepAttempt
	nextAttemptID int64
	heartbeats    int
	createdOrder  []string
}

func newMemoryWorkflowStorage() *memoryWorkflowStorage {
	return &memoryWorkflowStorage{
		runs:         make(map[string]*store.WorkflowRun),
		idempotency:  make(map[string]string),
		stepAttempts: make(map[string][]store.WorkflowStepAttempt),
	}
}

func (m *memoryWorkflowStorage) CreateWorkflowRun(ctx context.Context, params store.CreateWorkflowRunParams) (*store.WorkflowRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if params.IdempotencyKey != nil {
		key := m.idempotencyKey(params.Name, params.Version, *params.IdempotencyKey)
		if existingID, ok := m.idempotency[key]; ok {
			run := m.cloneRun(m.runs[existingID])
			return &run, nil
		}
	}

	now := time.Now().UTC()
	run := &store.WorkflowRun{
		ID:                      params.ID,
		Name:                    params.Name,
		Version:                 params.Version,
		Input:                   append([]byte(nil), params.Input...),
		Output:                  []byte("null"),
		Status:                  store.WorkflowRunStatePending,
		AvailableAt:             params.AvailableAt.UTC(),
		ParentRunID:             cloneStringPtr(params.ParentRunID),
		ParentStepName:          cloneStringPtr(params.ParentStepName),
		RootRunID:               cloneStringPtr(params.RootRunID),
		IdempotencyKey:          cloneStringPtr(params.IdempotencyKey),
		RetryInitialInterval:    params.RetryInitialInterval,
		RetryBackoffCoefficient: params.RetryBackoffCoefficient,
		RetryMaximumInterval:    params.RetryMaximumInterval,
		RetryMaximumAttempts:    params.RetryMaximumAttempts,
		CreatedAt:               now,
		UpdatedAt:               now,
		LastHeartbeatAt:         now,
	}
	m.runs[run.ID] = run
	m.createdOrder = append(m.createdOrder, run.ID)
	if params.IdempotencyKey != nil {
		m.idempotency[m.idempotencyKey(params.Name, params.Version, *params.IdempotencyKey)] = run.ID
	}
	clone := m.cloneRun(run)
	return &clone, nil
}

func (m *memoryWorkflowStorage) GetWorkflowRun(ctx context.Context, runID string) (*store.WorkflowRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[runID]
	if !ok {
		return nil, store.ErrWorkflowRunNotFound
	}
	clone := m.cloneRun(run)
	return &clone, nil
}

func (m *memoryWorkflowStorage) ClaimNextWorkflowRun(ctx context.Context, params store.ClaimWorkflowRunParams) (*store.WorkflowRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now().UTC()
	var selected *store.WorkflowRun
	for _, id := range m.createdOrder {
		run := m.runs[id]
		if run == nil {
			continue
		}
		if run.Status != store.WorkflowRunStatePending && run.Status != store.WorkflowRunStateRunning {
			continue
		}
		if run.AvailableAt.After(now) {
			continue
		}
		if selected == nil || run.AvailableAt.Before(selected.AvailableAt) || (run.AvailableAt.Equal(selected.AvailableAt) && run.CreatedAt.Before(selected.CreatedAt)) {
			selected = run
		}
	}
	if selected == nil {
		return nil, nil
	}

	if selected.Status == store.WorkflowRunStatePending ||
		(selected.Status == store.WorkflowRunStateRunning && selected.WaitReason == store.WorkflowWaitReasonNone) {
		selected.AttemptCount++
	}
	selected.Status = store.WorkflowRunStateRunning
	selected.WorkerID = params.WorkerID
	selected.LeaseToken = params.LeaseToken
	selected.AvailableAt = params.LeaseUntil.UTC()
	selected.UpdatedAt = now
	selected.LastHeartbeatAt = now
	clone := m.cloneRun(selected)
	return &clone, nil
}

func (m *memoryWorkflowStorage) HeartbeatWorkflowRun(ctx context.Context, runID, workerID, leaseToken string, leaseUntil time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[runID]
	if !ok || run.WorkerID != workerID || run.LeaseToken != leaseToken || run.Status != store.WorkflowRunStateRunning {
		return false, nil
	}
	now := time.Now().UTC()
	run.AvailableAt = leaseUntil.UTC()
	run.LastHeartbeatAt = now
	run.UpdatedAt = now
	m.heartbeats++
	return true, nil
}

func (m *memoryWorkflowStorage) CompleteWorkflowRun(ctx context.Context, params store.CompleteWorkflowRunParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[params.RunID]
	if !ok || run.WorkerID != params.WorkerID || run.LeaseToken != params.LeaseToken || run.Status != store.WorkflowRunStateRunning {
		return store.ErrWorkflowLeaseLost
	}
	now := time.Now().UTC()
	run.Output = append([]byte(nil), params.Output...)
	run.Status = store.WorkflowRunStateCompleted
	run.WorkerID = ""
	run.LeaseToken = ""
	run.WaitReason = store.WorkflowWaitReasonNone
	run.SleepUntil = nil
	run.AvailableAt = now
	run.ErrorMessage = ""
	run.UpdatedAt = now
	run.LastHeartbeatAt = now
	return nil
}

func (m *memoryWorkflowStorage) FailWorkflowRun(ctx context.Context, params store.FailWorkflowRunParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[params.RunID]
	if !ok || run.WorkerID != params.WorkerID || run.LeaseToken != params.LeaseToken {
		return store.ErrWorkflowLeaseLost
	}
	now := time.Now().UTC()
	run.Status = store.WorkflowRunStateFailed
	run.WorkerID = ""
	run.LeaseToken = ""
	run.WaitReason = store.WorkflowWaitReasonNone
	run.SleepUntil = nil
	run.AvailableAt = now
	run.ErrorMessage = params.ErrorMessage
	run.UpdatedAt = now
	run.LastHeartbeatAt = now
	return nil
}

func (m *memoryWorkflowStorage) RescheduleWorkflowRun(ctx context.Context, params store.RescheduleWorkflowRunParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[params.RunID]
	if !ok || run.WorkerID != params.WorkerID || run.LeaseToken != params.LeaseToken {
		return store.ErrWorkflowLeaseLost
	}
	now := time.Now().UTC()
	run.Status = params.Status
	run.WorkerID = ""
	run.LeaseToken = ""
	run.AvailableAt = params.AvailableAt.UTC()
	run.WaitReason = params.WaitReason
	run.SleepUntil = cloneTimePtr(params.SleepUntil)
	run.ErrorMessage = params.ErrorMessage
	run.UpdatedAt = now
	run.LastHeartbeatAt = now
	return nil
}

func (m *memoryWorkflowStorage) CancelWorkflowRun(ctx context.Context, runID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[runID]
	if !ok {
		return store.ErrWorkflowRunNotFound
	}
	if run.Status == store.WorkflowRunStateCompleted || run.Status == store.WorkflowRunStateFailed || run.Status == store.WorkflowRunStateCanceled {
		return nil
	}
	now := time.Now().UTC()
	run.Status = store.WorkflowRunStateCanceled
	run.WorkerID = ""
	run.LeaseToken = ""
	run.WaitReason = store.WorkflowWaitReasonNone
	run.SleepUntil = nil
	run.AvailableAt = now
	run.ErrorMessage = ""
	run.UpdatedAt = now
	run.LastHeartbeatAt = now
	return nil
}

func (m *memoryWorkflowStorage) ListWorkflowStepAttempts(ctx context.Context, runID string) ([]store.WorkflowStepAttempt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	attempts := m.stepAttempts[runID]
	result := make([]store.WorkflowStepAttempt, 0, len(attempts))
	for _, attempt := range attempts {
		result = append(result, m.cloneAttempt(attempt))
	}
	return result, nil
}

func (m *memoryWorkflowStorage) RecordWorkflowStepAttempt(ctx context.Context, params store.RecordWorkflowStepAttemptParams) (*store.WorkflowStepAttempt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[params.RunID]
	if !ok || run.WorkerID != params.WorkerID || run.LeaseToken != params.LeaseToken || run.Status != store.WorkflowRunStateRunning {
		return nil, store.ErrWorkflowLeaseLost
	}
	attempt := m.newAttempt(params)
	m.stepAttempts[params.RunID] = append(m.stepAttempts[params.RunID], attempt)
	clone := m.cloneAttempt(attempt)
	return &clone, nil
}

func (m *memoryWorkflowStorage) RecordWorkflowStepAttemptAndPark(ctx context.Context, params store.RecordWorkflowStepAttemptAndParkParams) (*store.WorkflowStepAttempt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[params.RunID]
	if !ok || run.WorkerID != params.WorkerID || run.LeaseToken != params.LeaseToken {
		return nil, store.ErrWorkflowLeaseLost
	}
	attempt := m.newAttempt(params.Attempt)
	m.stepAttempts[params.RunID] = append(m.stepAttempts[params.RunID], attempt)
	now := time.Now().UTC()
	run.Status = store.WorkflowRunStateRunning
	run.WorkerID = ""
	run.LeaseToken = ""
	run.AvailableAt = params.AvailableAt.UTC()
	run.WaitReason = params.WaitReason
	run.SleepUntil = cloneTimePtr(params.SleepUntil)
	run.ErrorMessage = ""
	run.UpdatedAt = now
	run.LastHeartbeatAt = now
	clone := m.cloneAttempt(attempt)
	return &clone, nil
}

func (m *memoryWorkflowStorage) heartbeatCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.heartbeats
}

func (m *memoryWorkflowStorage) runCountByName(name, version string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, run := range m.runs {
		if run.Name == name && run.Version == version {
			count++
		}
	}
	return count
}

func (m *memoryWorkflowStorage) newAttempt(params store.RecordWorkflowStepAttemptParams) store.WorkflowStepAttempt {
	m.nextAttemptID++
	now := time.Now().UTC()
	completedAt := cloneTimePtr(params.CompletedAt)
	if completedAt == nil && params.Status == store.WorkflowStepAttemptStateCompleted {
		completedAt = &now
	}
	return store.WorkflowStepAttempt{
		ID:            fmt.Sprintf("attempt-%d", m.nextAttemptID),
		RunID:         params.RunID,
		RunAttempt:    params.RunAttempt,
		StepName:      params.StepName,
		StepIndex:     params.StepIndex,
		StepType:      params.StepType,
		Status:        params.Status,
		Input:         append([]byte(nil), params.Input...),
		Output:        append([]byte(nil), params.Output...),
		ErrorMessage:  params.ErrorMessage,
		AttemptNumber: params.AttemptNumber,
		NextAttemptAt: cloneTimePtr(params.NextAttemptAt),
		SleepUntil:    cloneTimePtr(params.SleepUntil),
		ChildRunID:    cloneStringPtr(params.ChildRunID),
		CreatedAt:     now,
		CompletedAt:   completedAt,
	}
}

func (m *memoryWorkflowStorage) cloneRun(run *store.WorkflowRun) store.WorkflowRun {
	if run == nil {
		return store.WorkflowRun{}
	}
	clone := *run
	clone.Input = append([]byte(nil), run.Input...)
	clone.Output = append([]byte(nil), run.Output...)
	clone.SleepUntil = cloneTimePtr(run.SleepUntil)
	clone.IdempotencyKey = cloneStringPtr(run.IdempotencyKey)
	clone.ParentRunID = cloneStringPtr(run.ParentRunID)
	clone.ParentStepName = cloneStringPtr(run.ParentStepName)
	clone.RootRunID = cloneStringPtr(run.RootRunID)
	return clone
}

func (m *memoryWorkflowStorage) cloneAttempt(attempt store.WorkflowStepAttempt) store.WorkflowStepAttempt {
	attempt.Input = append([]byte(nil), attempt.Input...)
	attempt.Output = append([]byte(nil), attempt.Output...)
	attempt.NextAttemptAt = cloneTimePtr(attempt.NextAttemptAt)
	attempt.SleepUntil = cloneTimePtr(attempt.SleepUntil)
	attempt.ChildRunID = cloneStringPtr(attempt.ChildRunID)
	attempt.CompletedAt = cloneTimePtr(attempt.CompletedAt)
	return attempt
}

func (m *memoryWorkflowStorage) idempotencyKey(name, version, key string) string {
	return name + "\x00" + version + "\x00" + key
}

func cloneStringPtr(value *string) *string {
	if value == nil {
		return nil
	}
	v := *value
	return &v
}

func cloneTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	v := value.UTC()
	return &v
}
