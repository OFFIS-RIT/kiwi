package leaselock

import (
	"context"
	"errors"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	gonanoid "github.com/matoous/go-nanoid/v2"
)

var (
	ErrBusy = errors.New("lease lock busy")
	ErrLost = errors.New("lease lock lost")
)

type dbConn interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Client struct {
	db dbConn
}

type Options struct {
	TTL        time.Duration
	RenewEvery time.Duration

	Wait         bool
	WaitInterval time.Duration
	WaitJitter   time.Duration

	TokenPrefix string
}

type Lease struct {
	Key   string
	Token string

	Context context.Context

	client *Client
	cancel context.CancelCauseFunc

	stopOnce sync.Once
	stopCh   chan struct{}
}

func New(pool *pgxpool.Pool) *Client {
	return &Client{db: pool}
}

func (c *Client) WithLease(ctx context.Context, key string, opts Options, fn func(ctx context.Context) error) error {
	lease, err := c.Acquire(ctx, key, opts)
	if err != nil {
		return err
	}
	defer func() {
		_ = lease.Release(context.Background())
	}()
	return fn(lease.Context)
}

func (c *Client) Acquire(ctx context.Context, key string, opts Options) (*Lease, error) {
	if key == "" {
		return nil, errors.New("lease lock key is empty")
	}

	if opts.TTL <= 0 {
		opts.TTL = 5 * time.Minute
	}
	ttlMs := opts.TTL.Milliseconds()
	if ttlMs <= 0 {
		ttlMs = int64((5 * time.Minute).Milliseconds())
	}
	if opts.RenewEvery <= 0 {
		opts.RenewEvery = max(opts.TTL/2, time.Second)
	}
	if opts.RenewEvery >= opts.TTL {
		opts.RenewEvery = max(opts.TTL/2, time.Second)
	}
	if opts.WaitInterval <= 0 {
		opts.WaitInterval = 250 * time.Millisecond
	}
	if opts.WaitJitter < 0 {
		opts.WaitJitter = 0
	}

	tok, err := gonanoid.New()
	if err != nil {
		return nil, err
	}
	token := opts.TokenPrefix + tok

	acquireOnce := func(ctx context.Context) (bool, error) {
		var returnedKey string
		err := c.db.QueryRow(ctx, tryAcquireSQL, key, token, ttlMs).Scan(&returnedKey)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, nil
			}
			return false, err
		}
		return returnedKey != "", nil
	}

	for {
		ok, err := acquireOnce(ctx)
		if err != nil {
			return nil, err
		}
		if ok {
			break
		}
		if !opts.Wait {
			return nil, ErrBusy
		}
		if err := sleepWithJitter(ctx, opts.WaitInterval, opts.WaitJitter); err != nil {
			return nil, err
		}
	}

	leaseCtx, cancel := context.WithCancelCause(ctx)
	l := &Lease{
		Key:     key,
		Token:   token,
		Context: leaseCtx,
		client:  c,
		cancel:  cancel,
		stopCh:  make(chan struct{}),
	}

	go l.renewLoop(opts, ttlMs)

	return l, nil
}

func (l *Lease) Release(ctx context.Context) error {
	l.stopOnce.Do(func() {
		close(l.stopCh)
		l.cancel(context.Canceled)
	})

	_, err := l.client.db.Exec(ctx, releaseSQL, l.Key, l.Token)
	return err
}

func (l *Lease) renewLoop(opts Options, ttlMs int64) {
	t := time.NewTicker(opts.RenewEvery)
	defer t.Stop()

	for {
		select {
		case <-l.stopCh:
			return
		case <-l.Context.Done():
			return
		case <-t.C:
			if err := l.renewOnce(ttlMs); err != nil {
				l.cancel(err)
				return
			}
		}
	}
}

func (l *Lease) renewOnce(ttlMs int64) error {
	for attempt := range 3 {
		renewCtx, cancel := context.WithTimeout(l.Context, 15*time.Second)
		var returnedKey string
		err := l.client.db.QueryRow(renewCtx, renewSQL, l.Key, l.Token, ttlMs).Scan(&returnedKey)
		cancel()
		if err == nil {
			return nil
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrLost
		}
		if attempt == 2 {
			return err
		}
		if err := sleepWithJitter(l.Context, 200*time.Millisecond, 0); err != nil {
			return err
		}
	}
	return ErrLost
}

func sleepWithJitter(ctx context.Context, base, jitter time.Duration) error {
	d := base
	if jitter > 0 {
		d += time.Duration(rand.Int64N(int64(jitter) + 1))
	}
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

const tryAcquireSQL = `
INSERT INTO app_locks (lock_key, locked_by, expires_at)
VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'))
ON CONFLICT (lock_key) DO UPDATE
SET locked_by  = EXCLUDED.locked_by,
    expires_at = EXCLUDED.expires_at
WHERE app_locks.expires_at < now()
   OR app_locks.locked_by = EXCLUDED.locked_by
RETURNING lock_key;
`

const renewSQL = `
UPDATE app_locks
SET expires_at = now() + ($3::bigint * interval '1 millisecond')
WHERE lock_key = $1 AND locked_by = $2
RETURNING lock_key;
`

const releaseSQL = `
DELETE FROM app_locks
WHERE lock_key = $1 AND locked_by = $2;
`
