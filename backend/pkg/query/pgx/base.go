package pgx

import (
	"context"
	"fmt"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"
)

type queryOptions struct {
	SystemPrompts      []string
	Model              string
	Thinking           string
	ExpertGraphCatalog string
	AgenticPrompt      string
}

// QueryOption is a functional option for configuring query behavior.
type QueryOption func(*queryOptions)

// WithSystemPrompts returns a QueryOption that appends additional system
// prompts to guide the AI's response generation.
func WithSystemPrompts(prompts ...string) QueryOption {
	return func(o *queryOptions) {
		o.SystemPrompts = append(o.SystemPrompts, prompts...)
	}
}

// WithModel returns a QueryOption that specifies which AI model to use
// for generating responses.
func WithModel(model string) QueryOption {
	return func(o *queryOptions) {
		o.Model = model
	}
}

// WithThinking returns a QueryOption that enables extended thinking mode,
// allowing the AI to reason through complex queries before responding.
func WithThinking(thinking string) QueryOption {
	return func(o *queryOptions) {
		o.Thinking = thinking
	}
}

// WithExpertGraphCatalog returns a QueryOption that injects a preformatted
// expert graph catalog into the agentic system prompt.
func WithExpertGraphCatalog(catalog string) QueryOption {
	return func(o *queryOptions) {
		o.ExpertGraphCatalog = catalog
	}
}

// WithAgenticPrompt returns a QueryOption that overrides the base agentic
// system prompt.
func WithAgenticPrompt(prompt string) QueryOption {
	return func(o *queryOptions) {
		o.AgenticPrompt = prompt
	}
}

// BaseQueryClient provides a high-level interface for querying and
// analyzing graphs. It combines an AI client for reasoning over graph
// structures with a storage client for persisting and retrieving graph data.
type BaseQueryClient struct {
	aiClient      ai.GraphAIClient
	storageClient store.GraphStorage
	graphId       string
	options       queryOptions
}

// NewGraphQueryClient creates a new GraphQueryClient by combining an AI
// client and a storage client. The AI client is used for reasoning and
// enrichment, while the storage client provides access to persisted graph
// data.
//
// Example:
//
//	client := query.NewGraphQueryClient(aiClient, storageClient)
func NewGraphQueryClient(aiC ai.GraphAIClient, s store.GraphStorage, graphId string, opts []QueryOption) *BaseQueryClient {
	c := BaseQueryClient{
		aiClient:      aiC,
		storageClient: s,
		graphId:       graphId,
	}

	for _, o := range opts {
		o(&c.options)
	}

	return &c
}

// generateNoDataResponse generates a response in the user's language when no
// relevant context is found in the knowledge base
func (c *BaseQueryClient) generateNoDataResponse(ctx context.Context, query string) (string, error) {
	prompt := fmt.Sprintf(ai.NoDataPrompt, query)
	res, err := c.aiClient.GenerateCompletion(ctx, prompt)
	if err != nil {
		logger.Error("Failed to generate no data response", "err", err)
		return "There was a server error, please try again later.", err
	}

	return res, nil
}
