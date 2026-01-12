package query

import (
	"context"

	"kiwi/pkg/ai"
)

// GraphQueryClient defines the interface for querying knowledge graphs using AI.
// It provides methods for local queries (focused on specific entities), global
// queries (across the entire graph), and tool-augmented queries that can invoke
// external functions. Each query type has both blocking and streaming variants.
type GraphQueryClient interface {
	QueryLocal(
		ctx context.Context,
		msgs []ai.ChatMessage,
	) (string, error)
	QueryStreamLocal(
		ctx context.Context,
		msgs []ai.ChatMessage,
	) (<-chan string, error)

	QueryGlobal(
		ctx context.Context,
		msgs []ai.ChatMessage,
	) (string, error)
	QueryStreamGlobal(
		ctx context.Context,
		msgs []ai.ChatMessage,
	) (<-chan string, error)

	QueryTools(
		ctx context.Context,
		msgs []ai.ChatMessage,
		tools []ai.Tool,
	) (string, error)
	QueryStreamTools(
		ctx context.Context,
		msgs []ai.ChatMessage,
		tools []ai.Tool,
	) (<-chan string, error)
}
