package pgx

import (
	"context"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

// QueryAgentic performs a query with access to external tools. The AI can invoke
// the provided tools to gather additional information or perform actions before
// generating a final response. This enables agentic workflows where the AI
// can interact with external systems.
func (c *BaseQueryClient) QueryAgentic(
	ctx context.Context,
	msgs []ai.ChatMessage,
	tools []ai.Tool,
) (string, error) {
	aiC := c.aiClient

	systemPrompts := []string{ai.ToolQueryPrompt}
	if c.options.EnableClarification {
		systemPrompts = append(systemPrompts, ai.ToolQueryClarificationPrompt)
	}
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
		logger.Error("Error during agentic query", "err", err)
		return c.generateNoDataResponse(ctx, msgs[len(msgs)-1].Message)
	}

	return resp, nil
}

// QueryStreamAgentic performs a streaming query with access to external tools.
// It emits events for tool invocations and content chunks as they become
// available, enabling real-time visibility into the AI's reasoning and actions.
func (c *BaseQueryClient) QueryStreamAgentic(
	ctx context.Context,
	msgs []ai.ChatMessage,
	tools []ai.Tool,
) (<-chan ai.StreamEvent, error) {
	out := make(chan ai.StreamEvent, 10)
	aiC := c.aiClient

	go func() {
		defer close(out)

		systemPrompts := []string{ai.ToolQueryPrompt}
		if c.options.EnableClarification {
			systemPrompts = append(systemPrompts, ai.ToolQueryClarificationPrompt)
		}
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
			noDataResp, _ := c.generateNoDataResponse(ctx, msgs[len(msgs)-1].Message)
			out <- ai.StreamEvent{Type: "content", Content: noDataResp}
			return
		}

		for event := range resp {
			out <- event
		}
	}()

	return out, nil
}
