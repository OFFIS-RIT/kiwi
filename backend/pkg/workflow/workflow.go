package workflow

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// WorkflowSpec identifies a workflow implementation.
type WorkflowSpec struct {
	Name    string
	Version string
}

// Reference resolves to a workflow spec when starting runs.
type Reference interface {
	GetWorkflowSpec() WorkflowSpec
}

func (s WorkflowSpec) GetWorkflowSpec() WorkflowSpec {
	return normalizeWorkflowSpec(s)
}

// WorkflowFunc defines a workflow implementation.
type WorkflowFunc func(ctx context.Context, input any, step *StepAPI) (any, error)

// Workflow defines a registered durable workflow.
type Workflow struct {
	Spec        WorkflowSpec
	RetryPolicy RetryPolicy
	Handler     WorkflowFunc
}

func (w Workflow) GetWorkflowSpec() WorkflowSpec {
	return normalizeWorkflowSpec(w.Spec)
}

func (w Workflow) getRetryPolicy() *RetryPolicy {
	policy := normalizeWorkflowRetryPolicy(&w.RetryPolicy)
	return &policy
}

type WorkflowOption func(*Workflow)

func WithWorkflowRetryPolicy(policy RetryPolicy) WorkflowOption {
	return func(workflow *Workflow) {
		workflow.RetryPolicy = policy
	}
}

func DefineWorkflow(spec WorkflowSpec, handler WorkflowFunc, opts ...WorkflowOption) (Workflow, error) {
	workflow := Workflow{
		Spec:        normalizeWorkflowSpec(spec),
		RetryPolicy: DefaultWorkflowRetryPolicy(),
		Handler:     handler,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&workflow)
		}
	}
	if err := validateWorkflow(workflow); err != nil {
		return Workflow{}, err
	}
	workflow.RetryPolicy = normalizeWorkflowRetryPolicy(&workflow.RetryPolicy)
	return workflow, nil
}

func MustDefineWorkflow(spec WorkflowSpec, handler WorkflowFunc, opts ...WorkflowOption) Workflow {
	workflow, err := DefineWorkflow(spec, handler, opts...)
	if err != nil {
		panic(err)
	}
	return workflow
}

type registry struct {
	mu        sync.RWMutex
	workflows map[string]Workflow
}

func newRegistry() *registry {
	return &registry{workflows: make(map[string]Workflow)}
}

func (r *registry) Register(workflow Workflow) error {
	if err := validateWorkflow(workflow); err != nil {
		return err
	}

	key := workflowKey(workflow.Spec)

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.workflows[key]; exists {
		return fmt.Errorf("workflow %s already registered", describeSpec(workflow.Spec))
	}
	r.workflows[key] = workflow
	return nil
}

func (r *registry) Lookup(spec WorkflowSpec) (Workflow, bool) {
	key := workflowKey(spec)
	r.mu.RLock()
	defer r.mu.RUnlock()
	workflow, ok := r.workflows[key]
	return workflow, ok
}

func validateWorkflow(workflow Workflow) error {
	workflow.Spec = normalizeWorkflowSpec(workflow.Spec)
	if workflow.Spec.Name == "" {
		return fmt.Errorf("workflow name is required")
	}
	if workflow.Handler == nil {
		return fmt.Errorf("workflow %s handler is required", describeSpec(workflow.Spec))
	}
	return nil
}

func normalizeWorkflowSpec(spec WorkflowSpec) WorkflowSpec {
	return WorkflowSpec{
		Name:    strings.TrimSpace(spec.Name),
		Version: strings.TrimSpace(spec.Version),
	}
}

func workflowKey(spec WorkflowSpec) string {
	spec = normalizeWorkflowSpec(spec)
	return spec.Name + "\x00" + spec.Version
}

func describeSpec(spec WorkflowSpec) string {
	spec = normalizeWorkflowSpec(spec)
	if spec.Version == "" {
		return spec.Name
	}
	return spec.Name + "@" + spec.Version
}
