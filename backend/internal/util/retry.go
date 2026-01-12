package util

import (
	"context"
	"errors"
)

// Retry calls fn up to maxTries times until it returns a non-nil result and nil error.
// If maxTries <= 0, it defaults to 1. Returns the last error if all attempts fail.
func Retry[T any](maxTries int, fn func() (T, error)) (T, error) {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	var zero T
	for i := 0; i < maxTries; i++ {
		result, err := fn()
		if err == nil {
			return result, nil
		}
		lastErr = err
	}
	return zero, lastErr
}

// RetryErr calls fn up to maxTries times until it returns nil error.
// If maxTries <= 0, it defaults to 1. Returns the last error if all attempts fail.
func RetryErr(maxTries int, fn func() error) error {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	for i := 0; i < maxTries; i++ {
		err := fn()
		if err == nil {
			return nil
		}
		lastErr = err
	}
	return lastErr
}

func RetryErrWithContext(ctx context.Context, maxTries int, fn func(context.Context) error) error {
	if maxTries <= 0 {
		maxTries = 1
	}

	var lastErr error
	for i := 0; i < maxTries; i++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := fn(ctx)
		if err == nil {
			return nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		lastErr = err
	}
	return lastErr
}

// RetryWithContext calls fn up to maxTries times until it returns a non-nil result and nil error,
// or until ctx is done. If maxTries <= 0, it defaults to 1.
// Returns ctx.Err() if the context is canceled, otherwise returns the last error.
func RetryWithContext[T any](ctx context.Context, maxTries int, fn func(context.Context) (T, error)) (T, error) {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	var zero T
	for i := 0; i < maxTries; i++ {
		if ctx.Err() != nil {
			return zero, ctx.Err()
		}
		result, err := fn(ctx)
		if err == nil {
			return result, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return zero, err
		}
		lastErr = err
	}
	return zero, lastErr
}

// Retry2 calls fn up to maxTries times until it returns two results and nil error.
// If maxTries <= 0, it defaults to 1. Returns the last error if all attempts fail.
func Retry2[A, B any](maxTries int, fn func() (A, B, error)) (A, B, error) {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	var zeroA A
	var zeroB B
	for i := 0; i < maxTries; i++ {
		a, b, err := fn()
		if err == nil {
			return a, b, nil
		}
		lastErr = err
	}
	return zeroA, zeroB, lastErr
}

// Retry3 calls fn up to maxTries times until it returns three results and nil error.
// If maxTries <= 0, it defaults to 1. Returns the last error if all attempts fail.
func Retry3[A, B, C any](maxTries int, fn func() (A, B, C, error)) (A, B, C, error) {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	var zeroA A
	var zeroB B
	var zeroC C
	for i := 0; i < maxTries; i++ {
		a, b, c, err := fn()
		if err == nil {
			return a, b, c, nil
		}
		lastErr = err
	}
	return zeroA, zeroB, zeroC, lastErr
}

// Retry4 calls fn up to maxTries times until it returns four results and nil error.
// If maxTries <= 0, it defaults to 1. Returns the last error if all attempts fail.
func Retry4[A, B, C, D any](maxTries int, fn func() (A, B, C, D, error)) (A, B, C, D, error) {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	var zeroA A
	var zeroB B
	var zeroC C
	var zeroD D
	for i := 0; i < maxTries; i++ {
		a, b, c, d, err := fn()
		if err == nil {
			return a, b, c, d, nil
		}
		lastErr = err
	}
	return zeroA, zeroB, zeroC, zeroD, lastErr
}

// Retry2WithContext calls fn up to maxTries times until it returns two results and nil error,
// or until ctx is done. If maxTries <= 0, it defaults to 1.
// Returns ctx.Err() if the context is canceled, otherwise returns the last error.
func Retry2WithContext[A, B any](ctx context.Context, maxTries int, fn func(context.Context) (A, B, error)) (A, B, error) {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	var zeroA A
	var zeroB B
	for i := 0; i < maxTries; i++ {
		if ctx.Err() != nil {
			return zeroA, zeroB, ctx.Err()
		}
		a, b, err := fn(ctx)
		if err == nil {
			return a, b, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return zeroA, zeroB, err
		}
		lastErr = err
	}
	return zeroA, zeroB, lastErr
}

// Retry3WithContext calls fn up to maxTries times until it returns three results and nil error,
// or until ctx is done. If maxTries <= 0, it defaults to 1.
// Returns ctx.Err() if the context is canceled, otherwise returns the last error.
func Retry3WithContext[A, B, C any](ctx context.Context, maxTries int, fn func(context.Context) (A, B, C, error)) (A, B, C, error) {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	var zeroA A
	var zeroB B
	var zeroC C
	for i := 0; i < maxTries; i++ {
		if ctx.Err() != nil {
			return zeroA, zeroB, zeroC, ctx.Err()
		}
		a, b, c, err := fn(ctx)
		if err == nil {
			return a, b, c, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return zeroA, zeroB, zeroC, err
		}
		lastErr = err
	}
	return zeroA, zeroB, zeroC, lastErr
}

// Retry4WithContext calls fn up to maxTries times until it returns four results and nil error,
// or until ctx is done. If maxTries <= 0, it defaults to 1.
// Returns ctx.Err() if the context is canceled, otherwise returns the last error.
func Retry4WithContext[A, B, C, D any](ctx context.Context, maxTries int, fn func(context.Context) (A, B, C, D, error)) (A, B, C, D, error) {
	if maxTries <= 0 {
		maxTries = 1
	}
	var lastErr error
	var zeroA A
	var zeroB B
	var zeroC C
	var zeroD D
	for i := 0; i < maxTries; i++ {
		if ctx.Err() != nil {
			return zeroA, zeroB, zeroC, zeroD, ctx.Err()
		}
		a, b, c, d, err := fn(ctx)
		if err == nil {
			return a, b, c, d, nil
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return zeroA, zeroB, zeroC, zeroD, err
		}
		lastErr = err
	}
	return zeroA, zeroB, zeroC, zeroD, lastErr
}
