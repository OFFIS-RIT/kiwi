package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"
)

// Client runs and registers durable workflows.
type Client struct {
	storage  store.WorkflowStorage
	registry *registry
}

type ClientOption func(*Client) error

func WithStorage(storageBackend store.WorkflowStorage) ClientOption {
	return func(client *Client) error {
		if storageBackend == nil {
			return fmt.Errorf("workflow storage is nil")
		}
		client.storage = storageBackend
		return nil
	}
}

func NewClient(opts ...ClientOption) (*Client, error) {
	client := &Client{registry: newRegistry()}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		if err := opt(client); err != nil {
			return nil, err
		}
	}
	if client.storage == nil {
		return nil, fmt.Errorf("workflow storage is required")
	}
	return client, nil
}

func (c *Client) ImplementWorkflow(workflow Workflow) error {
	return c.registry.Register(workflow)
}

func (c *Client) RunWorkflow(ctx context.Context, ref Reference, input any, opts ...RunOption) (*Handle, error) {
	run, err := c.enqueueWorkflowRun(ctx, ref, input, opts...)
	if err != nil {
		return nil, err
	}
	return &Handle{runID: run.ID, storage: c.storage}, nil
}

func (c *Client) CancelWorkflow(ctx context.Context, runID string) error {
	return c.storage.CancelWorkflowRun(ctx, runID)
}

func (c *Client) Handle(runID string) *Handle {
	return &Handle{runID: runID, storage: c.storage}
}

func (c *Client) NewWorker(opts ...WorkerOption) *Worker {
	return newWorker(c, opts...)
}

type runOptions struct {
	runID          string
	idempotencyKey *string
	availableAt    *time.Time
	retryPolicy    *RetryPolicy
	parentRunID    *string
	parentStepName *string
	rootRunID      *string
}

// RunOption customizes workflow run creation.
type RunOption func(*runOptions)

func WithRunID(runID string) RunOption {
	return func(opts *runOptions) {
		opts.runID = runID
	}
}

func WithIdempotencyKey(key string) RunOption {
	return func(opts *runOptions) {
		trimmed := key
		opts.idempotencyKey = &trimmed
	}
}

func WithRunRetryPolicy(policy RetryPolicy) RunOption {
	return func(opts *runOptions) {
		normalized := normalizeWorkflowRetryPolicy(&policy)
		opts.retryPolicy = &normalized
	}
}

func withAvailableAt(at time.Time) RunOption {
	return func(opts *runOptions) {
		t := at
		opts.availableAt = &t
	}
}

func withParentRun(parentRunID, parentStepName string, rootRunID *string) RunOption {
	return func(opts *runOptions) {
		parentID := parentRunID
		stepName := parentStepName
		opts.parentRunID = &parentID
		opts.parentStepName = &stepName
		if rootRunID != nil {
			rootID := *rootRunID
			opts.rootRunID = &rootID
		}
	}
}

func (c *Client) enqueueWorkflowRun(ctx context.Context, ref Reference, input any, opts ...RunOption) (*store.WorkflowRun, error) {
	if ref == nil {
		return nil, fmt.Errorf("workflow reference is required")
	}

	spec := ref.GetWorkflowSpec()
	if spec.Name == "" {
		return nil, fmt.Errorf("workflow name is required")
	}

	runOpts := runOptions{}
	for _, opt := range opts {
		if opt != nil {
			opt(&runOpts)
		}
	}

	runID := runOpts.runID
	if runID == "" {
		runID = ids.New()
	}

	inputJSON, err := marshalValue(input)
	if err != nil {
		return nil, fmt.Errorf("marshal workflow input: %w", err)
	}

	availableAt := time.Now().UTC()
	if runOpts.availableAt != nil {
		availableAt = runOpts.availableAt.UTC()
	}

	retryPolicy := c.resolveRunRetryPolicy(ref, runOpts.retryPolicy)

	run, err := c.storage.CreateWorkflowRun(ctx, store.CreateWorkflowRunParams{
		ID:                      runID,
		Name:                    spec.Name,
		Version:                 spec.Version,
		Input:                   inputJSON,
		AvailableAt:             availableAt,
		IdempotencyKey:          runOpts.idempotencyKey,
		ParentRunID:             runOpts.parentRunID,
		ParentStepName:          runOpts.parentStepName,
		RootRunID:               runOpts.rootRunID,
		RetryInitialInterval:    retryPolicy.InitialInterval,
		RetryBackoffCoefficient: retryPolicy.BackoffCoefficient,
		RetryMaximumInterval:    retryPolicy.MaximumInterval,
		RetryMaximumAttempts:    retryPolicy.MaximumAttempts,
	})
	if err != nil {
		return nil, err
	}

	if !equalJSON(run.Input, inputJSON) {
		return nil, fmt.Errorf("workflow %s idempotency key returned a run with different input", describeSpec(spec))
	}

	return run, nil
}

func (c *Client) resolveRunRetryPolicy(ref Reference, override *RetryPolicy) RetryPolicy {
	if override != nil {
		return normalizeWorkflowRetryPolicy(override)
	}
	if withPolicy, ok := ref.(interface{ getRetryPolicy() *RetryPolicy }); ok {
		return normalizeWorkflowRetryPolicy(withPolicy.getRetryPolicy())
	}
	return DefaultWorkflowRetryPolicy()
}

func marshalValue(value any) ([]byte, error) {
	if value == nil {
		return []byte("null"), nil
	}
	b, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return b, nil
}

func unmarshalValue(raw []byte) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func compactJSON(raw []byte) []byte {
	if len(raw) == 0 {
		return nil
	}
	var compacted bytes.Buffer
	if err := json.Compact(&compacted, raw); err != nil {
		return raw
	}
	return compacted.Bytes()
}

func equalJSON(left []byte, right []byte) bool {
	left = compactJSON(left)
	right = compactJSON(right)
	if bytes.Equal(left, right) {
		return true
	}

	var leftValue any
	if err := json.Unmarshal(left, &leftValue); err != nil {
		return false
	}

	var rightValue any
	if err := json.Unmarshal(right, &rightValue); err != nil {
		return false
	}

	return reflect.DeepEqual(leftValue, rightValue)
}
