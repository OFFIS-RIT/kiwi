package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrWorkflowRunNotFound = errors.New("workflow run not found")
	ErrWorkflowLeaseLost   = errors.New("workflow run lease lost")
)

type WorkflowRunState string

const (
	WorkflowRunStatePending   WorkflowRunState = "pending"
	WorkflowRunStateRunning   WorkflowRunState = "running"
	WorkflowRunStateCompleted WorkflowRunState = "completed"
	WorkflowRunStateFailed    WorkflowRunState = "failed"
	WorkflowRunStateCanceled  WorkflowRunState = "canceled"
)

type WorkflowWaitReason string

const (
	WorkflowWaitReasonNone        WorkflowWaitReason = ""
	WorkflowWaitReasonSleep       WorkflowWaitReason = "sleep"
	WorkflowWaitReasonStepRetry   WorkflowWaitReason = "step_retry"
	WorkflowWaitReasonChildRun    WorkflowWaitReason = "child_workflow"
	WorkflowWaitReasonRunRetry    WorkflowWaitReason = "run_retry"
	WorkflowWaitReasonMissingImpl WorkflowWaitReason = "missing_workflow"
)

type WorkflowStepKind string

const (
	WorkflowStepKindRun      WorkflowStepKind = "run"
	WorkflowStepKindSleep    WorkflowStepKind = "sleep"
	WorkflowStepKindWorkflow WorkflowStepKind = "workflow"
)

type WorkflowStepAttemptState string

const (
	WorkflowStepAttemptStateCompleted WorkflowStepAttemptState = "completed"
	WorkflowStepAttemptStateFailed    WorkflowStepAttemptState = "failed"
)

type WorkflowRun struct {
	ID                      string
	Name                    string
	Version                 string
	Input                   []byte
	Output                  []byte
	Status                  WorkflowRunState
	ErrorMessage            string
	AttemptCount            int
	AvailableAt             time.Time
	WorkerID                string
	LeaseToken              string
	WaitReason              WorkflowWaitReason
	SleepUntil              *time.Time
	IdempotencyKey          *string
	ParentRunID             *string
	ParentStepName          *string
	RootRunID               *string
	RetryInitialInterval    time.Duration
	RetryBackoffCoefficient float64
	RetryMaximumInterval    time.Duration
	RetryMaximumAttempts    int
	CreatedAt               time.Time
	UpdatedAt               time.Time
	LastHeartbeatAt         time.Time
}

type CreateWorkflowRunParams struct {
	ID                      string
	Name                    string
	Version                 string
	Input                   []byte
	AvailableAt             time.Time
	IdempotencyKey          *string
	ParentRunID             *string
	ParentStepName          *string
	RootRunID               *string
	RetryInitialInterval    time.Duration
	RetryBackoffCoefficient float64
	RetryMaximumInterval    time.Duration
	RetryMaximumAttempts    int
}

type ClaimWorkflowRunParams struct {
	WorkerID   string
	LeaseUntil time.Time
	LeaseToken string
}

type CompleteWorkflowRunParams struct {
	RunID      string
	WorkerID   string
	LeaseToken string
	Output     []byte
}

type FailWorkflowRunParams struct {
	RunID        string
	WorkerID     string
	LeaseToken   string
	ErrorMessage string
}

type RescheduleWorkflowRunParams struct {
	RunID        string
	WorkerID     string
	LeaseToken   string
	Status       WorkflowRunState
	AvailableAt  time.Time
	ErrorMessage string
	WaitReason   WorkflowWaitReason
	SleepUntil   *time.Time
}

type WorkflowStepAttempt struct {
	ID            string
	RunID         string
	RunAttempt    int
	StepName      string
	StepIndex     int
	StepType      WorkflowStepKind
	Status        WorkflowStepAttemptState
	Input         []byte
	Output        []byte
	ErrorMessage  string
	AttemptNumber int
	NextAttemptAt *time.Time
	SleepUntil    *time.Time
	ChildRunID    *string
	CreatedAt     time.Time
	CompletedAt   *time.Time
}

type RecordWorkflowStepAttemptParams struct {
	RunID         string
	WorkerID      string
	LeaseToken    string
	RunAttempt    int
	StepName      string
	StepIndex     int
	StepType      WorkflowStepKind
	Status        WorkflowStepAttemptState
	Input         []byte
	Output        []byte
	ErrorMessage  string
	AttemptNumber int
	NextAttemptAt *time.Time
	SleepUntil    *time.Time
	ChildRunID    *string
	CompletedAt   *time.Time
}

type RecordWorkflowStepAttemptAndParkParams struct {
	Attempt     RecordWorkflowStepAttemptParams
	RunID       string
	WorkerID    string
	LeaseToken  string
	AvailableAt time.Time
	WaitReason  WorkflowWaitReason
	SleepUntil  *time.Time
}

type WorkflowStorage interface {
	CreateWorkflowRun(ctx context.Context, params CreateWorkflowRunParams) (*WorkflowRun, error)
	GetWorkflowRun(ctx context.Context, runID string) (*WorkflowRun, error)
	ClaimNextWorkflowRun(ctx context.Context, params ClaimWorkflowRunParams) (*WorkflowRun, error)
	HeartbeatWorkflowRun(ctx context.Context, runID, workerID, leaseToken string, leaseUntil time.Time) (bool, error)
	CompleteWorkflowRun(ctx context.Context, params CompleteWorkflowRunParams) error
	FailWorkflowRun(ctx context.Context, params FailWorkflowRunParams) error
	RescheduleWorkflowRun(ctx context.Context, params RescheduleWorkflowRunParams) error
	CancelWorkflowRun(ctx context.Context, runID string) error
	ListWorkflowStepAttempts(ctx context.Context, runID string) ([]WorkflowStepAttempt, error)
	RecordWorkflowStepAttempt(ctx context.Context, params RecordWorkflowStepAttemptParams) (*WorkflowStepAttempt, error)
	RecordWorkflowStepAttemptAndPark(ctx context.Context, params RecordWorkflowStepAttemptAndParkParams) (*WorkflowStepAttempt, error)
}
