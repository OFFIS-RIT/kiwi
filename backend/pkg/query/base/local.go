package base

import (
	"context"
	"fmt"

	"kiwi/pkg/ai"
)

// QueryLocal performs a local query against the knowledge graph. It retrieves
// context from semantically similar entities using vector embeddings, then
// generates a response using the AI client. If no relevant context is found,
// it returns a "no data" response rather than hallucinating.
func (c *BaseQueryClient) QueryLocal(
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

	context, err = sC.GetLocalQueryContext(ctx, query, embedding, c.graphId)
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

// QueryStreamLocal performs a streaming local query against the knowledge graph.
// It emits progress events and content chunks as they become available. Like
// QueryLocal, it uses vector similarity to find relevant context and returns
// a "no data" response if no relevant context is found.
func (c *BaseQueryClient) QueryStreamLocal(
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

		context, err := sC.GetLocalQueryContext(ctx, query, embedding, c.graphId)
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
