package query

import (
	"context"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
)

// GraphQueryClient defines the interface for querying knowledge graphs using AI.
// It provides methods for local queries (manuell context building), and agentic queries that can invoke
// external functions (self context building). Each query type has both blocking and streaming variants.
type GraphQueryClient interface {
	QueryLocal(
		ctx context.Context,
		msgs []ai.ChatMessage,
	) (string, error)
	QueryStreamLocal(
		ctx context.Context,
		msgs []ai.ChatMessage,
	) (<-chan string, error)

	QueryAgentic(
		ctx context.Context,
		msgs []ai.ChatMessage,
		tools []ai.Tool,
	) (string, error)
	QueryStreamAgentic(
		ctx context.Context,
		msgs []ai.ChatMessage,
		tools []ai.Tool,
	) (<-chan string, error)
}
