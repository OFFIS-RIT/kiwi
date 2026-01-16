package base

import (
	"context"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	return &GraphDBStorage{
		conn:        conn,
		aiClient:    aiClient,
		dbLock:      sync.Mutex{},
	}, nil
}
