package workflow

import "time"

const maxTotalStepAttempts = 1000

const defaultChildWorkflowPollInterval = 10 * time.Millisecond

// RetryPolicy controls retry timing and attempt limits for workflow runs and steps.
type RetryPolicy struct {
	InitialInterval    time.Duration
	BackoffCoefficient float64
	MaximumInterval    time.Duration
	MaximumAttempts    int
}

func DefaultWorkflowRetryPolicy() RetryPolicy {
	return RetryPolicy{
		InitialInterval:    time.Second,
		BackoffCoefficient: 2,
		MaximumInterval:    30 * time.Second,
		MaximumAttempts:    3,
	}
}

func DefaultStepRetryPolicy() RetryPolicy {
	return RetryPolicy{
		InitialInterval:    time.Second,
		BackoffCoefficient: 2,
		MaximumInterval:    30 * time.Second,
		MaximumAttempts:    1,
	}
}

func normalizeWorkflowRetryPolicy(policy *RetryPolicy) RetryPolicy {
	return normalizeRetryPolicy(policy, DefaultWorkflowRetryPolicy())
}

func normalizeStepRetryPolicy(policy *RetryPolicy) RetryPolicy {
	return normalizeRetryPolicy(policy, DefaultStepRetryPolicy())
}

func normalizeRetryPolicy(policy *RetryPolicy, defaults RetryPolicy) RetryPolicy {
	if policy == nil {
		return defaults
	}

	normalized := *policy
	if normalized.InitialInterval <= 0 {
		normalized.InitialInterval = defaults.InitialInterval
	}
	if normalized.BackoffCoefficient < 1 {
		normalized.BackoffCoefficient = defaults.BackoffCoefficient
	}
	if normalized.MaximumInterval <= 0 {
		normalized.MaximumInterval = defaults.MaximumInterval
	}
	if normalized.MaximumAttempts <= 0 {
		normalized.MaximumAttempts = defaults.MaximumAttempts
	}
	if normalized.MaximumInterval < normalized.InitialInterval {
		normalized.MaximumInterval = normalized.InitialInterval
	}

	return normalized
}

func nextRetryDelay(policy RetryPolicy, attempt int) time.Duration {
	if attempt <= 0 {
		attempt = 1
	}

	delay := float64(policy.InitialInterval)
	for i := 1; i < attempt; i++ {
		delay *= policy.BackoffCoefficient
	}

	if maxDelay := float64(policy.MaximumInterval); delay > maxDelay {
		delay = maxDelay
	}

	return time.Duration(delay)
}
