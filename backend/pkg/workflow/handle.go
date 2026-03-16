package workflow

import (
	"context"
	"fmt"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"
)

const defaultHandlePollInterval = 250 * time.Millisecond

// RunError reports a terminal workflow run state.
type RunError struct {
	RunID   string
	Status  store.WorkflowRunState
	Message string
}

func (e *RunError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("workflow run %s %s: %s", e.RunID, e.Status, e.Message)
	}
	return fmt.Sprintf("workflow run %s %s", e.RunID, e.Status)
}

// Handle references a workflow run.
type Handle struct {
	runID   string
	storage store.WorkflowStorage
}

func (h *Handle) ID() string {
	return h.runID
}

func (h *Handle) Status(ctx context.Context) (store.WorkflowRunState, error) {
	run, err := h.storage.GetWorkflowRun(ctx, h.runID)
	if err != nil {
		return "", err
	}
	return run.Status, nil
}

func (h *Handle) Result(ctx context.Context) (any, error) {
	ticker := time.NewTicker(defaultHandlePollInterval)
	defer ticker.Stop()

	for {
		run, err := h.storage.GetWorkflowRun(ctx, h.runID)
		if err != nil {
			return nil, err
		}

		switch run.Status {
		case store.WorkflowRunStateCompleted:
			return unmarshalValue(run.Output)
		case store.WorkflowRunStateFailed, store.WorkflowRunStateCanceled:
			return nil, &RunError{RunID: run.ID, Status: run.Status, Message: run.ErrorMessage}
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (h *Handle) Cancel(ctx context.Context) error {
	return h.storage.CancelWorkflowRun(ctx, h.runID)
}
