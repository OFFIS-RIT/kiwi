package util

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRetry_SuccessImmediate(t *testing.T) {
	result, err := Retry(3, func() (int, error) {
		return 42, nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if result != 42 {
		t.Fatalf("expected 42, got %d", result)
	}
}

func TestRetry_SuccessAfterRetries(t *testing.T) {
	calls := 0
	result, err := Retry(3, func() (int, error) {
		calls++
		if calls < 3 {
			return 0, errors.New("transient")
		}
		return 99, nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if result != 99 {
		t.Fatalf("expected 99, got %d", result)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry_PersistentFailure(t *testing.T) {
	calls := 0
	_, err := Retry(3, func() (int, error) {
		calls++
		return 0, errors.New("persistent")
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != "persistent" {
		t.Fatalf("expected persistent error, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry_MaxTriesZeroOrNegative(t *testing.T) {
	calls := 0
	_, err := Retry(0, func() (int, error) {
		calls++
		return 0, errors.New("fail")
	})
	if calls != 1 {
		t.Fatalf("expected 1 call for maxTries=0, got %d", calls)
	}
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	calls = 0
	_, err = Retry(-2, func() (int, error) {
		calls++
		return 0, errors.New("fail")
	})
	if calls != 1 {
		t.Fatalf("expected 1 call for maxTries=-2, got %d", calls)
	}
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestRetryErr_SuccessImmediate(t *testing.T) {
	err := RetryErr(3, func() error {
		return nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
}

func TestRetryErr_SuccessAfterRetries(t *testing.T) {
	calls := 0
	err := RetryErr(3, func() error {
		calls++
		if calls < 3 {
			return errors.New("transient")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetryErr_PersistentFailure(t *testing.T) {
	calls := 0
	err := RetryErr(3, func() error {
		calls++
		return errors.New("persistent")
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != "persistent" {
		t.Fatalf("expected persistent error, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetryWithContext_SuccessImmediate(t *testing.T) {
	ctx := context.Background()
	result, err := RetryWithContext(ctx, 3, func(ctx context.Context) (string, error) {
		return "ok", nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if result != "ok" {
		t.Fatalf("expected ok, got %s", result)
	}
}

func TestRetryWithContext_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	calls := 0
	_, err := RetryWithContext(ctx, 3, func(ctx context.Context) (int, error) {
		calls++
		return 0, nil
	})
	if err == nil {
		t.Fatal("expected context error, got nil")
	}
	if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context error, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("expected 0 calls due to immediate cancellation, got %d", calls)
	}
}

func TestRetryWithContext_ContextDeadlineExceeded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	calls := 0
	_, err := RetryWithContext(ctx, 100, func(ctx context.Context) (int, error) {
		calls++
		time.Sleep(5 * time.Millisecond)
		return 0, errors.New("transient")
	})
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context error (DeadlineExceeded or Canceled), got %v", err)
	}
	// Allow some tolerance for timing; at least 1 call should have been made
	if calls == 0 {
		t.Fatal("expected at least 1 call before deadline")
	}
}

func TestRetryWithContext_FunctionReturnsContextError(t *testing.T) {
	ctx := context.Background()
	calls := 0
	_, err := RetryWithContext(ctx, 3, func(ctx context.Context) (int, error) {
		calls++
		if calls < 2 {
			return 0, errors.New("transient")
		}
		return 0, context.Canceled
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected 2 calls, got %d", calls)
	}
}

// Tests for Retry2

func TestRetry2_SuccessImmediate(t *testing.T) {
	a, b, err := Retry2(3, func() (int, string, error) {
		return 42, "ok", nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if a != 42 {
		t.Fatalf("expected 42, got %d", a)
	}
	if b != "ok" {
		t.Fatalf("expected ok, got %s", b)
	}
}

func TestRetry2_SuccessAfterRetries(t *testing.T) {
	calls := 0
	a, b, err := Retry2(3, func() (int, string, error) {
		calls++
		if calls < 3 {
			return 0, "", errors.New("transient")
		}
		return 99, "yes", nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if a != 99 {
		t.Fatalf("expected 99, got %d", a)
	}
	if b != "yes" {
		t.Fatalf("expected yes, got %s", b)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry2_PersistentFailure(t *testing.T) {
	calls := 0
	_, _, err := Retry2(3, func() (int, string, error) {
		calls++
		return 0, "", errors.New("persistent")
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != "persistent" {
		t.Fatalf("expected persistent error, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry2_MaxTriesZeroOrNegative(t *testing.T) {
	calls := 0
	_, _, err := Retry2(0, func() (int, string, error) {
		calls++
		return 0, "", errors.New("fail")
	})
	if calls != 1 {
		t.Fatalf("expected 1 call for maxTries=0, got %d", calls)
	}
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestRetry2WithContext_SuccessImmediate(t *testing.T) {
	ctx := context.Background()
	a, b, err := Retry2WithContext(ctx, 3, func(ctx context.Context) (int, string, error) {
		return 7, "ctx", nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if a != 7 {
		t.Fatalf("expected 7, got %d", a)
	}
	if b != "ctx" {
		t.Fatalf("expected ctx, got %s", b)
	}
}

func TestRetry2WithContext_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	_, _, err := Retry2WithContext(ctx, 3, func(ctx context.Context) (int, string, error) {
		calls++
		return 0, "", nil
	})
	if err == nil {
		t.Fatal("expected context error, got nil")
	}
	if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context error, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("expected 0 calls due to immediate cancellation, got %d", calls)
	}
}

// Tests for Retry3

func TestRetry3_SuccessImmediate(t *testing.T) {
	a, b, c, err := Retry3(3, func() (int, string, bool, error) {
		return 1, "a", true, nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if a != 1 || b != "a" || c != true {
		t.Fatalf("expected (1, a, true), got (%d, %s, %v)", a, b, c)
	}
}

func TestRetry3_SuccessAfterRetries(t *testing.T) {
	calls := 0
	a, b, c, err := Retry3(3, func() (int, string, bool, error) {
		calls++
		if calls < 3 {
			return 0, "", false, errors.New("transient")
		}
		return 2, "b", false, nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if a != 2 || b != "b" || c != false {
		t.Fatalf("expected (2, b, false), got (%d, %s, %v)", a, b, c)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry3_PersistentFailure(t *testing.T) {
	calls := 0
	_, _, _, err := Retry3(3, func() (int, string, bool, error) {
		calls++
		return 0, "", false, errors.New("persistent")
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != "persistent" {
		t.Fatalf("expected persistent error, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry3WithContext_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	_, _, _, err := Retry3WithContext(ctx, 3, func(ctx context.Context) (int, string, bool, error) {
		calls++
		return 0, "", false, nil
	})
	if err == nil {
		t.Fatal("expected context error, got nil")
	}
	if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context error, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("expected 0 calls due to immediate cancellation, got %d", calls)
	}
}

// Tests for Retry4

func TestRetry4_SuccessImmediate(t *testing.T) {
	a, b, c, d, err := Retry4(3, func() (int, string, bool, float64, error) {
		return 1, "a", true, 3.14, nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if a != 1 || b != "a" || c != true || d != 3.14 {
		t.Fatalf("expected (1, a, true, 3.14), got (%d, %s, %v, %f)", a, b, c, d)
	}
}

func TestRetry4_SuccessAfterRetries(t *testing.T) {
	calls := 0
	a, b, c, d, err := Retry4(3, func() (int, string, bool, float64, error) {
		calls++
		if calls < 3 {
			return 0, "", false, 0, errors.New("transient")
		}
		return 2, "b", false, 2.71, nil
	})
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if a != 2 || b != "b" || c != false || d != 2.71 {
		t.Fatalf("expected (2, b, false, 2.71), got (%d, %s, %v, %f)", a, b, c, d)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry4_PersistentFailure(t *testing.T) {
	calls := 0
	_, _, _, _, err := Retry4(3, func() (int, string, bool, float64, error) {
		calls++
		return 0, "", false, 0, errors.New("persistent")
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != "persistent" {
		t.Fatalf("expected persistent error, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry4WithContext_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	_, _, _, _, err := Retry4WithContext(ctx, 3, func(ctx context.Context) (int, string, bool, float64, error) {
		calls++
		return 0, "", false, 0, nil
	})
	if err == nil {
		t.Fatal("expected context error, got nil")
	}
	if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context error, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("expected 0 calls due to immediate cancellation, got %d", calls)
	}
}
