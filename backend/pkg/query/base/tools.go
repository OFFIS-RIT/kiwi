package base

import (
	"context"

	"kiwi/pkg/ai"
)

// QueryTool performs a query with access to external tools. The AI can invoke
// the provided tools to gather additional information or perform actions before
// generating a final response. This enables agentic workflows where the AI
// can interact with external systems.
func (c *BaseQueryClient) QueryTool(
	ctx context.Context,
	msgs []ai.ChatMessage,
	tools []ai.Tool,
) (string, error) {
	aiC := c.aiClient

	systemPrompts := []string{ai.ToolQueryPrompt}
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

	resp, err := aiC.GenerateChatWithTools(ctx, msgs, tools, generateOpts...)
	if err != nil {
		return "", err
	}

	return resp, nil
}

// QueryStreamTool performs a streaming query with access to external tools.
// It emits events for tool invocations and content chunks as they become
// available, enabling real-time visibility into the AI's reasoning and actions.
func (c *BaseQueryClient) QueryStreamTool(
	ctx context.Context,
	msgs []ai.ChatMessage,
	tools []ai.Tool,
) (<-chan ai.StreamEvent, error) {
	aiC := c.aiClient

	systemPrompts := []string{ai.ToolQueryPrompt}
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

	resp, err := aiC.GenerateChatStreamWithTools(ctx, msgs, tools, generateOpts...)
	if err != nil {
		return nil, err
	}

	return resp, nil
}
