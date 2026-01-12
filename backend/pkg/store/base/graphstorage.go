package base

import (
	"context"
	"kiwi/internal/util"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"kiwi/pkg/ai"
)

type pgxIConn interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, optionsAndArgs ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, optionsAndArgs ...any) pgx.Row
	Begin(ctx context.Context) (pgx.Tx, error)
}

// GraphDBStorage implements the GraphStorage interface using PostgreSQL with
// pgvector for vector similarity search. It manages concurrent access with
// a mutex and limits parallel AI requests to prevent overloading.
type GraphDBStorage struct {
	conn        pgxIConn
	aiClient    ai.GraphAIClient
	msgs        []string
	maxParallel int
	dbLock      sync.Mutex
}

// NewGraphDBStorageWithConnection creates a new GraphDBStorage using an existing
// database connection. The AI client is used for generating embeddings and the
// msgs slice contains conversation history for context-aware queries.
func NewGraphDBStorageWithConnection(
	ctx context.Context,
	conn pgxIConn,
	aiClient ai.GraphAIClient,
	msgs []string,
) (*GraphDBStorage, error) {
	maxParallel := int(util.GetEnvNumeric("AI_PARALLEL_REQ", 15))
	return &GraphDBStorage{
		conn:        conn,
		aiClient:    aiClient,
		maxParallel: maxParallel,
		dbLock:      sync.Mutex{},
	}, nil
}
