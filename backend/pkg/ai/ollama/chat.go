package ollama

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"kiwi/pkg/ai"

	"github.com/ollama/ollama/api"
	"github.com/pkoukk/tiktoken-go"
)

// GenerateCompletion sends a single-turn prompt and returns assistant text.
func (c *GraphOllamaClient) GenerateCompletion(
	ctx context.Context,
	prompt string,
	opts ...ai.GenerateOption,
) (string, error) {
	options := ai.GenerateOptions{
		Model:       c.descriptionModel,
		Temperature: 0.3,
		Thinking:    "",
	}
	for _, o := range opts {
		o(&options)
	}

	stream := false
	req := &api.ChatRequest{
		Model: options.Model,
		Messages: []api.Message{
			{Role: "user", Content: prompt},
		},
		Stream:  &stream,
		Options: map[string]any{"temperature": options.Temperature},
	}

	if options.Thinking != "" {
		req.Think = &api.ThinkValue{
			Value: options.Thinking,
		}
	}

	tokens := 200
	enc, err := tiktoken.GetEncoding("o200k_base")
	if err != nil {
		return "", err
	}
	tokensArray := enc.Encode(prompt, nil, nil)
	for _, t := range tokensArray {
		tokens += t
	}
	if tokens > 4096 {
		req.Options["num_ctx"] = tokens
	}

	var final api.ChatResponse
	if err := c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
		final.Message.Content += cr.Message.Content
		if cr.Done {
			final.Done = true
			final.Metrics = cr.Metrics
		}
		return nil
	}); err != nil {
		return "", err
	}

	durationMs := final.Metrics.TotalDuration.Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  final.Metrics.PromptEvalCount,
		OutputTokens: final.Metrics.EvalCount,
		TotalTokens:  final.Metrics.PromptEvalCount + final.Metrics.EvalCount,
		DurationMs:   durationMs,
	}
	c.modifyMetrics(metrics)

	return final.Message.Content, nil
}

// GenerateCompletionWithFormat enforces a JSON schema and unmarshals into out.
func (c *GraphOllamaClient) GenerateCompletionWithFormat(
	ctx context.Context,
	name string,
	description string,
	prompt string,
	out any,
	opts ...ai.GenerateOption,
) error {
	if out == nil {
		return errors.New("out must be a non-nil pointer")
	}
	rv := reflect.ValueOf(out)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		return errors.New("out must be a non-nil pointer")
	}

	schemaObj := ai.GenerateSchema(out)
	formatBytes, err := json.Marshal(schemaObj)
	if err != nil {
		return err
	}
	var format json.RawMessage = formatBytes

	options := ai.GenerateOptions{
		Model:       c.extractionModel,
		Temperature: 0.1,
		Thinking:    "",
	}
	for _, o := range opts {
		o(&options)
	}

	stream := false
	req := &api.ChatRequest{
		Model: options.Model,
		Messages: []api.Message{
			{Role: "user", Content: prompt},
		},
		Stream:  &stream,
		Format:  format,
		Options: map[string]any{"temperature": options.Temperature},
	}

	if options.Thinking != "" {
		req.Think = &api.ThinkValue{
			Value: options.Thinking,
		}
	}

	tokens := 200
	enc, err := tiktoken.GetEncoding("o200k_base")
	if err != nil {
		return err
	}
	tokensArray := enc.Encode(prompt, nil, nil)
	for _, t := range tokensArray {
		tokens += t
	}
	if tokens > 4096 {
		req.Options["num_ctx"] = tokens
	}

	var final api.ChatResponse
	if err := c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
		final.Message.Content += cr.Message.Content
		if cr.Done {
			final.Done = true
			final.Metrics = cr.Metrics
		}
		return nil
	}); err != nil {
		return err
	}

	durationMs := final.Metrics.TotalDuration.Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  final.Metrics.PromptEvalCount,
		OutputTokens: final.Metrics.EvalCount,
		TotalTokens:  final.Metrics.PromptEvalCount + final.Metrics.EvalCount,
		DurationMs:   durationMs,
	}
	c.modifyMetrics(metrics)

	content := final.Message.Content
	return ai.UnmarshalFlexible(content, out)
}

// GenerateChat sends a multi-turn conversation and returns assistant text.
func (c *GraphOllamaClient) GenerateChat(
	ctx context.Context,
	messages []ai.ChatMessage,
	opts ...ai.GenerateOption,
) (string, error) {
	options := ai.GenerateOptions{
		Model:         c.descriptionModel,
		SystemPrompts: []string{},
		Temperature:   0.2,
		Thinking:      "",
	}
	for _, o := range opts {
		o(&options)
	}

	msgs := make([]api.Message, 0, len(options.SystemPrompts)+len(messages))
	for _, sys := range options.SystemPrompts {
		msgs = append(msgs, api.Message{Role: "system", Content: sys})
	}
	for _, m := range messages {
		role := m.Role
		if role == "" {
			role = "user"
		}
		msgs = append(msgs, api.Message{Role: role, Content: m.Message})
	}

	stream := false
	req := &api.ChatRequest{
		Model:    options.Model,
		Messages: msgs,
		Stream:   &stream,
		Options:  map[string]any{"temperature": options.Temperature},
	}

	if options.Thinking != "" {
		req.Think = &api.ThinkValue{
			Value: options.Thinking,
		}
	}

	tokens := 200
	enc, err := tiktoken.GetEncoding("o200k_base")
	if err != nil {
		return "", err
	}
	var chatString strings.Builder
	for _, c := range messages {
		chatString.WriteString(c.Message + "")
	}
	tokensArray := enc.Encode(chatString.String(), nil, nil)
	for _, t := range tokensArray {
		tokens += t
	}
	if tokens > 4096 {
		req.Options["num_ctx"] = tokens
	}

	var final api.ChatResponse
	if err := c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
		final.Message.Content += cr.Message.Content
		if cr.Done {
			final.Done = true
			final.Metrics = cr.Metrics
		}
		return nil
	}); err != nil {
		return "", err
	}

	metrics := ai.ModelMetrics{
		InputTokens:  final.Metrics.PromptEvalCount,
		OutputTokens: final.Metrics.EvalCount,
		TotalTokens:  final.Metrics.PromptEvalCount + final.Metrics.EvalCount,
		DurationMs:   final.Metrics.TotalDuration.Milliseconds(),
	}
	c.modifyMetrics(metrics)

	return final.Message.Content, nil
}

// GenerateChatStream streams the assistant reply incrementally.
func (c *GraphOllamaClient) GenerateChatStream(
	ctx context.Context,
	messages []ai.ChatMessage,
	opts ...ai.GenerateOption,
) (<-chan ai.StreamEvent, error) {
	options := ai.GenerateOptions{
		Model:         c.descriptionModel,
		SystemPrompts: []string{},
		Temperature:   0.2,
		Thinking:      "",
	}
	for _, o := range opts {
		o(&options)
	}

	msgs := make([]api.Message, 0, len(options.SystemPrompts)+len(messages))
	for _, sys := range options.SystemPrompts {
		msgs = append(msgs, api.Message{Role: "system", Content: sys})
	}
	for _, m := range messages {
		role := m.Role
		if role == "" {
			role = "user"
		}
		msgs = append(msgs, api.Message{Role: role, Content: m.Message})
	}

	stream := true
	req := &api.ChatRequest{
		Model:    options.Model,
		Messages: msgs,
		Stream:   &stream,
		Options:  map[string]any{"temperature": options.Temperature},
	}

	if options.Thinking != "" {
		req.Think = &api.ThinkValue{
			Value: options.Thinking,
		}
	}

	tokens := 200
	enc, err := tiktoken.GetEncoding("o200k_base")
	if err != nil {
		return nil, err
	}
	var chatString strings.Builder
	for _, c := range messages {
		chatString.WriteString(c.Message + "")
	}
	tokensArray := enc.Encode(chatString.String(), nil, nil)
	for _, t := range tokensArray {
		tokens += t
	}
	if tokens > 4096 {
		req.Options["num_ctx"] = tokens
	}

	out := make(chan ai.StreamEvent, 16)

	go func() {
		defer close(out)

		_ = c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
			if s := cr.Message.Content; s != "" {
				select {
				case out <- ai.StreamEvent{Type: "content", Content: s}:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			if cr.Done {
				metrics := ai.ModelMetrics{
					InputTokens:  cr.Metrics.PromptEvalCount,
					OutputTokens: cr.Metrics.EvalCount,
					TotalTokens:  cr.Metrics.PromptEvalCount + cr.Metrics.EvalCount,
					DurationMs:   cr.TotalDuration.Milliseconds(),
				}
				c.modifyMetrics(metrics)
				return nil
			}
			return nil
		})
	}()

	return out, nil
}

// LoadModel preloads a model into memory to reduce latency on subsequent requests.
func (c *GraphOllamaClient) LoadModel(ctx context.Context, opts ...ai.GenerateOption) error {
	options := ai.GenerateOptions{
		Model: c.descriptionModel,
	}
	for _, o := range opts {
		o(&options)
	}

	req := &api.ChatRequest{
		Model: options.Model,
	}

	if err := c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
		return nil
	}); err != nil {
		return err
	}

	return nil
}

// GenerateCompletionWithTools sends a prompt to the chat model with a set of
// tools that the model can call. When the model requests a tool call, the
// provided handler function is automatically executed, and the conversation
// continues with the tool result. This loop continues until the model provides
// a final response without requesting any tool calls, or until the maximum
// number of rounds (5) is reached.
//
// Example:
//
//	tools := []ai.Tool{
//		{
//			Name:        "get_weather",
//			Description: "Get weather at the given location",
//			Parameters: map[string]any{
//				"type": "object",
//				"properties": map[string]any{
//					"location": map[string]string{"type": "string"},
//				},
//				"required": []string{"location"},
//			},
//			Handler: func(ctx context.Context, args string) (string, error) {
//				var params map[string]any
//				json.Unmarshal([]byte(args), &params)
//				location := params["location"].(string)
//				return fmt.Sprintf("Sunny, 72°F in %s", location), nil
//			},
//		},
//	}
//
//	response, err := client.GenerateCompletionWithTools(
//		ctx,
//		"What is the weather in New York City?",
//		tools,
//	)
func (c *GraphOllamaClient) GenerateCompletionWithTools(
	ctx context.Context,
	prompt string,
	tools []ai.Tool,
	opts ...ai.GenerateOption,
) (string, error) {
	options := ai.GenerateOptions{
		Model:       c.descriptionModel,
		Temperature: 0.3,
		Thinking:    "",
	}
	for _, o := range opts {
		o(&options)
	}

	maxRounds := 10
	messages := []api.Message{
		{Role: "user", Content: prompt},
	}

	ollamaTools := make(api.Tools, len(tools))
	for i, tool := range tools {
		params := api.ToolFunctionParameters{
			Type:       "object",
			Required:   []string{},
			Properties: map[string]api.ToolProperty{},
		}

		if tool.Parameters != nil {
			if props, ok := tool.Parameters["properties"].(map[string]any); ok {
				for name, prop := range props {
					if propMap, ok := prop.(map[string]any); ok {
						tp := api.ToolProperty{}
						if t, ok := propMap["type"].(string); ok {
							tp.Type = api.PropertyType([]string{t})
						}
						if desc, ok := propMap["description"].(string); ok {
							tp.Description = desc
						}
						if enum, ok := propMap["enum"].([]any); ok {
							tp.Enum = enum
						}
						params.Properties[name] = tp
					}
				}
			}
			if reqInterface, ok := tool.Parameters["required"].([]any); ok {
				params.Required = make([]string, len(reqInterface))
				for i, v := range reqInterface {
					if s, ok := v.(string); ok {
						params.Required[i] = s
					}
				}
			} else if req, ok := tool.Parameters["required"].([]string); ok {
				params.Required = req
			}
		}

		ollamaTools[i] = api.Tool{
			Type: "function",
			Function: api.ToolFunction{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  params,
			},
		}
	}

	for range maxRounds {
		stream := false
		req := &api.ChatRequest{
			Model:    options.Model,
			Messages: messages,
			Tools:    ollamaTools,
			Stream:   &stream,
			Options:  map[string]any{"temperature": options.Temperature},
		}

		if options.Thinking != "" {
			req.Think = &api.ThinkValue{
				Value: options.Thinking,
			}
		}

		tokens := 200
		enc, err := tiktoken.GetEncoding("o200k_base")
		if err != nil {
			return "", err
		}
		tokensArray := enc.Encode(prompt, nil, nil)
		for _, t := range tokensArray {
			tokens += t
		}
		if tokens > 4096 {
			req.Options["num_ctx"] = tokens
		}

		var final api.ChatResponse
		if err := c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
			final.Message.Content += cr.Message.Content
			final.Message.ToolCalls = cr.Message.ToolCalls
			if cr.Done {
				final.Done = true
				final.Metrics = cr.Metrics
			}
			return nil
		}); err != nil {
			return "", err
		}

		metrics := ai.ModelMetrics{
			InputTokens:  final.Metrics.PromptEvalCount,
			OutputTokens: final.Metrics.EvalCount,
			TotalTokens:  final.Metrics.PromptEvalCount + final.Metrics.EvalCount,
			DurationMs:   final.Metrics.TotalDuration.Milliseconds(),
		}
		c.modifyMetrics(metrics)

		if len(final.Message.ToolCalls) == 0 {
			return final.Message.Content, nil
		}

		messages = append(messages, final.Message)

		for _, tc := range final.Message.ToolCalls {
			var handler ai.ToolHandler
			for _, tool := range tools {
				if tool.Name == tc.Function.Name {
					handler = tool.Handler
					break
				}
			}

			if handler == nil {
				return "", fmt.Errorf("no handler found for tool: %s", tc.Function.Name)
			}

			argsBytes, err := json.Marshal(tc.Function.Arguments)
			if err != nil {
				return "", fmt.Errorf("failed to marshal tool arguments: %w", err)
			}

			result, err := handler(ctx, string(argsBytes))
			if err != nil {
				return "", fmt.Errorf("tool %s failed: %w", tc.Function.Name, err)
			}

			messages = append(messages, api.Message{
				Role:    "tool",
				Content: result,
			})
		}
	}

	return "", fmt.Errorf("max tool rounds (%d) exceeded", maxRounds)
}

// GenerateChatWithTools sends a multi-turn conversation with tools that the model can call.
// Tool calls are automatically executed and their results fed back until the model produces
// a final response without tool calls, or until the maximum rounds (20) is reached.
func (c *GraphOllamaClient) GenerateChatWithTools(
	ctx context.Context,
	messages []ai.ChatMessage,
	tools []ai.Tool,
	opts ...ai.GenerateOption,
) (string, error) {
	options := ai.GenerateOptions{
		Model:         c.descriptionModel,
		SystemPrompts: []string{},
		Temperature:   0.2,
		Thinking:      "",
	}
	for _, o := range opts {
		o(&options)
	}

	maxRounds := 20
	msgs := make([]api.Message, 0, len(options.SystemPrompts)+len(messages))
	for _, sys := range options.SystemPrompts {
		msgs = append(msgs, api.Message{Role: "system", Content: sys})
	}
	for _, m := range messages {
		role := m.Role
		if role == "" {
			role = "user"
		}
		msgs = append(msgs, api.Message{Role: role, Content: m.Message})
	}

	ollamaTools := make(api.Tools, len(tools))
	for i, tool := range tools {
		params := api.ToolFunctionParameters{
			Type:       "object",
			Required:   []string{},
			Properties: map[string]api.ToolProperty{},
		}

		if tool.Parameters != nil {
			if props, ok := tool.Parameters["properties"].(map[string]any); ok {
				for name, prop := range props {
					if propMap, ok := prop.(map[string]any); ok {
						tp := api.ToolProperty{}
						if t, ok := propMap["type"].(string); ok {
							tp.Type = api.PropertyType([]string{t})
						}
						if desc, ok := propMap["description"].(string); ok {
							tp.Description = desc
						}
						if enum, ok := propMap["enum"].([]any); ok {
							tp.Enum = enum
						}
						params.Properties[name] = tp
					}
				}
			}
			if reqInterface, ok := tool.Parameters["required"].([]any); ok {
				params.Required = make([]string, len(reqInterface))
				for i, v := range reqInterface {
					if s, ok := v.(string); ok {
						params.Required[i] = s
					}
				}
			} else if req, ok := tool.Parameters["required"].([]string); ok {
				params.Required = req
			}
		}

		ollamaTools[i] = api.Tool{
			Type: "function",
			Function: api.ToolFunction{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  params,
			},
		}
	}

	for range maxRounds {
		stream := false
		req := &api.ChatRequest{
			Model:    options.Model,
			Messages: msgs,
			Tools:    ollamaTools,
			Stream:   &stream,
			Options:  map[string]any{"temperature": options.Temperature},
		}

		if options.Thinking != "" {
			req.Think = &api.ThinkValue{
				Value: options.Thinking,
			}
		}

		tokens := 200
		enc, err := tiktoken.GetEncoding("o200k_base")
		if err != nil {
			return "", err
		}
		var chatString strings.Builder
		for _, c := range messages {
			chatString.WriteString(c.Message + "")
		}
		tokensArray := enc.Encode(chatString.String(), nil, nil)
		for _, t := range tokensArray {
			tokens += t
		}
		if tokens > 4096 {
			req.Options["num_ctx"] = tokens
		}

		var final api.ChatResponse
		if err := c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
			final.Message.Content += cr.Message.Content
			final.Message.ToolCalls = cr.Message.ToolCalls
			if cr.Done {
				final.Done = true
				final.Metrics = cr.Metrics
				final.TotalDuration = cr.TotalDuration
			}
			return nil
		}); err != nil {
			return "", err
		}

		metrics := ai.ModelMetrics{
			InputTokens:  final.Metrics.PromptEvalCount,
			OutputTokens: final.Metrics.EvalCount,
			TotalTokens:  final.Metrics.PromptEvalCount + final.Metrics.EvalCount,
			DurationMs:   final.TotalDuration.Milliseconds(),
		}
		c.modifyMetrics(metrics)

		if len(final.Message.ToolCalls) == 0 {
			return final.Message.Content, nil
		}

		msgs = append(msgs, final.Message)

		for _, tc := range final.Message.ToolCalls {
			var handler ai.ToolHandler
			for _, tool := range tools {
				if tool.Name == tc.Function.Name {
					handler = tool.Handler
					break
				}
			}

			if handler == nil {
				return "", fmt.Errorf("no handler found for tool: %s", tc.Function.Name)
			}

			argsBytes, err := json.Marshal(tc.Function.Arguments)
			if err != nil {
				return "", fmt.Errorf("failed to marshal tool arguments: %w", err)
			}

			result, err := handler(ctx, string(argsBytes))
			if err != nil {
				return "", fmt.Errorf("tool %s failed: %w", tc.Function.Name, err)
			}

			msgs = append(msgs, api.Message{
				Role:    "tool",
				Content: result,
			})
		}
	}

	return "", fmt.Errorf("max tool rounds (%d) exceeded", maxRounds)
}

// GenerateChatStreamWithTools sends a multi-turn conversation with tools and streams the final response.
// Tool calls are processed in non-streaming mode until the model is ready to produce its final
// response, which is then streamed incrementally through the returned channel.
func (c *GraphOllamaClient) GenerateChatStreamWithTools(
	ctx context.Context,
	messages []ai.ChatMessage,
	tools []ai.Tool,
	opts ...ai.GenerateOption,
) (<-chan ai.StreamEvent, error) {
	options := ai.GenerateOptions{
		Model:         c.descriptionModel,
		SystemPrompts: []string{},
		Temperature:   0.2,
		Thinking:      "",
	}
	for _, o := range opts {
		o(&options)
	}

	msgs := make([]api.Message, 0, len(options.SystemPrompts)+len(messages))
	for _, sys := range options.SystemPrompts {
		msgs = append(msgs, api.Message{Role: "system", Content: sys})
	}
	for _, m := range messages {
		role := m.Role
		if role == "" {
			role = "user"
		}
		msgs = append(msgs, api.Message{Role: role, Content: m.Message})
	}

	ollamaTools := make(api.Tools, len(tools))
	for i, tool := range tools {
		params := api.ToolFunctionParameters{
			Type:       "object",
			Required:   []string{},
			Properties: map[string]api.ToolProperty{},
		}

		if tool.Parameters != nil {
			if props, ok := tool.Parameters["properties"].(map[string]any); ok {
				for name, prop := range props {
					if propMap, ok := prop.(map[string]any); ok {
						tp := api.ToolProperty{}
						if t, ok := propMap["type"].(string); ok {
							tp.Type = api.PropertyType([]string{t})
						}
						if desc, ok := propMap["description"].(string); ok {
							tp.Description = desc
						}
						if enum, ok := propMap["enum"].([]any); ok {
							tp.Enum = enum
						}
						params.Properties[name] = tp
					}
				}
			}
			if reqInterface, ok := tool.Parameters["required"].([]any); ok {
				params.Required = make([]string, len(reqInterface))
				for i, v := range reqInterface {
					if s, ok := v.(string); ok {
						params.Required[i] = s
					}
				}
			} else if req, ok := tool.Parameters["required"].([]string); ok {
				params.Required = req
			}
		}

		ollamaTools[i] = api.Tool{
			Type: "function",
			Function: api.ToolFunction{
				Name:        tool.Name,
				Description: tool.Description,
				Parameters:  params,
			},
		}
	}

	maxRounds := 20
	for range maxRounds {
		stream := false
		req := &api.ChatRequest{
			Model:    options.Model,
			Messages: msgs,
			Tools:    ollamaTools,
			Stream:   &stream,
			Options:  map[string]any{"temperature": options.Temperature},
		}

		if options.Thinking != "" {
			req.Think = &api.ThinkValue{
				Value: options.Thinking,
			}
		}

		tokens := 200
		enc, err := tiktoken.GetEncoding("o200k_base")
		if err != nil {
			return nil, err
		}
		var chatString strings.Builder
		for _, c := range messages {
			chatString.WriteString(c.Message + "")
		}
		tokensArray := enc.Encode(chatString.String(), nil, nil)
		for _, t := range tokensArray {
			tokens += t
		}
		if tokens > 4096 {
			req.Options["num_ctx"] = tokens
		}

		var final api.ChatResponse
		if err := c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
			final.Message.Content += cr.Message.Content
			final.Message.ToolCalls = cr.Message.ToolCalls
			if cr.Done {
				final.Done = true
				final.Metrics = cr.Metrics
				final.TotalDuration = cr.TotalDuration
			}
			return nil
		}); err != nil {
			return nil, err
		}

		metrics := ai.ModelMetrics{
			InputTokens:  final.Metrics.PromptEvalCount,
			OutputTokens: final.Metrics.EvalCount,
			TotalTokens:  final.Metrics.PromptEvalCount + final.Metrics.EvalCount,
			DurationMs:   final.TotalDuration.Milliseconds(),
		}
		c.modifyMetrics(metrics)

		if len(final.Message.ToolCalls) == 0 {
			break
		}

		msgs = append(msgs, final.Message)

		for _, tc := range final.Message.ToolCalls {
			var handler ai.ToolHandler
			for _, tool := range tools {
				if tool.Name == tc.Function.Name {
					handler = tool.Handler
					break
				}
			}

			if handler == nil {
				return nil, fmt.Errorf("no handler found for tool: %s", tc.Function.Name)
			}

			argsBytes, err := json.Marshal(tc.Function.Arguments)
			if err != nil {
				return nil, fmt.Errorf("failed to marshal tool arguments: %w", err)
			}

			result, err := handler(ctx, string(argsBytes))
			if err != nil {
				return nil, fmt.Errorf("tool %s failed: %w", tc.Function.Name, err)
			}

			msgs = append(msgs, api.Message{
				Role:    "tool",
				Content: result,
			})
		}
	}

	out := make(chan ai.StreamEvent, 16)

	go func() {
		defer close(out)

		stream := true
		req := &api.ChatRequest{
			Model:    options.Model,
			Messages: msgs,
			Stream:   &stream,
			Options:  map[string]any{"temperature": options.Temperature},
		}

		if options.Thinking != "" {
			req.Think = &api.ThinkValue{
				Value: options.Thinking,
			}
		}

		tokens := 200
		enc, err := tiktoken.GetEncoding("o200k_base")
		if err != nil {
			return
		}
		var chatString strings.Builder
		for _, c := range messages {
			chatString.WriteString(c.Message + "")
		}
		tokensArray := enc.Encode(chatString.String(), nil, nil)
		for _, t := range tokensArray {
			tokens += t
		}
		if tokens > 4096 {
			req.Options["num_ctx"] = tokens
		}

		_ = c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
			if s := cr.Message.Content; s != "" {
				select {
				case out <- ai.StreamEvent{Type: "content", Content: s}:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			if cr.Done {
				metrics := ai.ModelMetrics{
					InputTokens:  cr.Metrics.PromptEvalCount,
					OutputTokens: cr.Metrics.EvalCount,
					TotalTokens:  cr.Metrics.PromptEvalCount + cr.Metrics.EvalCount,
					DurationMs:   cr.TotalDuration.Milliseconds(),
				}
				c.modifyMetrics(metrics)
				return nil
			}
			return nil
		})
	}()

	return out, nil
}
