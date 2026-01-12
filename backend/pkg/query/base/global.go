package base

import (
	"context"
	"fmt"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
)

// QueryGlobal performs a global query across the entire knowledge graph. Unlike
// local queries that focus on specific entities, global queries aggregate context
// from multiple sources to answer broader questions. Returns a "no data" response
// if no relevant context is found.
func (c *BaseQueryClient) QueryGlobal(
	ctx context.Context,
	msgs []ai.ChatMessage,
) (string, error) {
	query := msgs[len(msgs)-1].Message
	var context string
	var err error

	aiC := c.aiClient
	sC := c.storageClient

	embedding, err := aiC.GenerateEmbedding(ctx, []byte(query))
	if err != nil {
		return "", err
	}

	context, err = sC.GetGlobalQueryContext(ctx, query, embedding, c.graphId)
	if err != nil {
		return "", err
	}

	// If no relevant context found, generate a "no data" response instead of hallucinating
	if context == "" {
		return c.generateNoDataResponse(ctx, query)
	}

	prompt := fmt.Sprintf(ai.QueryPrompt, context)
	systemPrompts := []string{prompt}
	if len(systemPrompts) > 0 {
		systemPrompts = append(systemPrompts, c.options.SystemPrompts...)
	}

	generateOpts := []ai.GenerateOption{
		ai.WithSystemPrompts(systemPrompts...),
	}
	if c.options.Model != "" {
		generateOpts = append(generateOpts, ai.WithModel(c.options.Model))
	}
	if c.options.Thinking != "" {
		generateOpts = append(generateOpts, ai.WithThinking(c.options.Thinking))
	}

	resp, err := aiC.GenerateChat(ctx, msgs, generateOpts...)
	if err != nil {
		return "", fmt.Errorf("Failed to generate answer from AI:\n%w", err)
	}

	return resp, nil
}

// QueryStreamGlobal performs a streaming global query across the knowledge graph.
// It emits progress events and content chunks as they become available. Like
// QueryGlobal, it aggregates context from multiple sources to answer broader
// questions.
func (c *BaseQueryClient) QueryStreamGlobal(
	ctx context.Context,
	msgs []ai.ChatMessage,
) (<-chan ai.StreamEvent, error) {
	out := make(chan ai.StreamEvent, 10)

	go func() {
		defer close(out)

		out <- ai.StreamEvent{Type: "step", Step: "db_query"}

		query := msgs[len(msgs)-1].Message

		aiC := c.aiClient
		sC := c.storageClient

		embedding, err := aiC.GenerateEmbedding(ctx, []byte(query))
		if err != nil {
			return
		}

		context, err := sC.GetGlobalQueryContext(ctx, query, embedding, c.graphId)
		if err != nil {
			return
		}

		// If no relevant context found, generate a "no data" response instead of hallucinating
		if context == "" {
			noDataResp, err := c.generateNoDataResponse(ctx, query)
			if err != nil {
				return
			}
			out <- ai.StreamEvent{Type: "content", Content: noDataResp}
			return
		}

		prompt := fmt.Sprintf(ai.QueryPrompt, context)
		systemPrompts := []string{prompt}
		if len(c.options.SystemPrompts) > 0 {
			systemPrompts = append(systemPrompts, c.options.SystemPrompts...)
		}

		generateOpts := []ai.GenerateOption{
			ai.WithSystemPrompts(systemPrompts...),
		}
		if c.options.Model != "" {
			generateOpts = append(generateOpts, ai.WithModel(c.options.Model))
		}
		if c.options.Thinking != "" {
			generateOpts = append(generateOpts, ai.WithThinking(c.options.Thinking))
		}

		resp, err := aiC.GenerateChatStream(ctx, msgs, generateOpts...)
		if err != nil {
			return
		}

		for event := range resp {
			out <- event
		}
	}()

	return out, nil
}
