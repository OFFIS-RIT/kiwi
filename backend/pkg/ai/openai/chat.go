package openai

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/shared"
)

// GenerateCompletion sends a single-turn prompt to the chat model and
// returns the generated completion as plain text.
//
// This method is best suited for simple prompt-response interactions.
//
// Example:
//
//	resp, err := client.GenerateCompletion(ctx, "Summarize this text...")
//	if err != nil {
//		log.Fatal(err)
//	}
//	fmt.Println(resp)
func (c *GraphOpenAIClient) GenerateCompletion(
	ctx context.Context,
	prompt string,
	opts ...ai.GenerateOption,
) (string, error) {
	client := c.ChatClient

	options := ai.GenerateOptions{
		Model:       c.descriptionModel,
		Temperature: 0.3,
		Thinking:    "",
	}
	for _, o := range opts {
		o(&options)
	}

	msgs := []openai.ChatCompletionMessageParamUnion{}
	if len(options.SystemPrompts) > 0 {
		for _, sp := range options.SystemPrompts {
			msgs = append(msgs, openai.SystemMessage(sp))
		}
	}

	msgs = append(msgs, openai.UserMessage(prompt))

	body := openai.ChatCompletionNewParams{
		Model:           openai.ChatModel(options.Model),
		Messages:        msgs,
		ReasoningEffort: shared.ReasoningEffort(options.Thinking),
		Temperature:     openai.Float(options.Temperature),
	}

	if options.Thinking != "" {
		// Needed fix for gpt-5 models as they dont support temperature other than 1.0 when reasoning is enabled
		if c.chatURL == "" {
			body.Temperature = openai.Float(1.0)
		}
		body.ReasoningEffort = shared.ReasoningEffort(options.Thinking)
	}

	start := time.Now()
	response, err := client.Chat.Completions.New(ctx, body)
	if err != nil {
		return "", err
	}
	duration := time.Since(start).Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  int(response.Usage.PromptTokens),
		OutputTokens: int(response.Usage.CompletionTokens),
		TotalTokens:  int(response.Usage.TotalTokens),
		DurationMs:   duration,
	}
	c.modifyMetrics(metrics)

	return response.Choices[0].Message.Content, nil
}

// GenerateCompletionWithFormat sends a prompt to the chat model and
// attempts to unmarshal the response into the provided output struct,
// using a JSON schema to enforce structure.
//
// This is useful when you need structured AI output (e.g., entities,
// relationships, or reports).
//
// Example:
//
//	var out MyStruct
//	err := client.GenerateCompletionWithFormat(ctx, "Extract entities...", &out)
//	if err != nil {
//		log.Fatal(err)
//	}
//	fmt.Printf("%+v\n", out)
func (c *GraphOpenAIClient) GenerateCompletionWithFormat(
	ctx context.Context,
	name string,
	description string,
	prompt string,
	out any,
	opts ...ai.GenerateOption,
) error {
	schema := ai.GenerateSchema(out)
	schemaParam := openai.ResponseFormatJSONSchemaJSONSchemaParam{
		Name:        name,
		Description: openai.String(description),
		Schema:      schema,
		Strict:      openai.Bool(true),
	}

	options := ai.GenerateOptions{
		Model:       c.descriptionModel,
		Temperature: 0.1,
		Thinking:    "",
	}
	for _, o := range opts {
		o(&options)
	}

	msgs := []openai.ChatCompletionMessageParamUnion{}
	if len(options.SystemPrompts) > 0 {
		for _, sp := range options.SystemPrompts {
			msgs = append(msgs, openai.SystemMessage(sp))
		}
	}

	msgs = append(msgs, openai.UserMessage(prompt))

	body := openai.ChatCompletionNewParams{
		Model: openai.ChatModel(options.Model),
		ResponseFormat: openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONSchema: &openai.ResponseFormatJSONSchemaParam{
				JSONSchema: schemaParam,
			},
		},
		Messages:    msgs,
		Temperature: openai.Float(options.Temperature),
	}

	if options.Thinking != "" {
		// Needed fix for gpt-5 models as they dont support temperature other than 1.0 when reasoning is enabled
		if c.chatURL == "" {
			body.Temperature = openai.Float(1.0)
		}
		body.ReasoningEffort = shared.ReasoningEffort(options.Thinking)
	}

	start := time.Now()
	response, err := c.ChatClient.Chat.Completions.New(ctx, body)
	if err != nil {
		return err
	}
	duration := time.Since(start).Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  int(response.Usage.PromptTokens),
		OutputTokens: int(response.Usage.CompletionTokens),
		TotalTokens:  int(response.Usage.TotalTokens),
		DurationMs:   duration,
	}
	c.modifyMetrics(metrics)

	if len(response.Choices) == 0 {
		return fmt.Errorf("no choices in response from model")
	}
	message := response.Choices[0].Message.Content
	if message == "" {
		return fmt.Errorf("empty response from model (finish_reason: %s)", response.Choices[0].FinishReason)
	}
	return ai.UnmarshalFlexible(message, out)
}

// GenerateChat sends a multi-turn chat conversation to the model and
// returns the assistant’s reply as plain text.
//
// The `system` parameter defines the system prompt (instructions for the AI).
// The `messages` parameter contains the conversation history.
// The `temp` parameter controls randomness (0.0 = deterministic).
//
// Example:
//
//	msgs := []ai.ChatMessage{
//		{Role: "user", Message: "Hello, who are you?"},
//	}
//	resp, err := client.GenerateChat(ctx, "You are a helpful assistant.", msgs, 0.7)
//	if err != nil {
//		log.Fatal(err)
//	}
//	fmt.Println(resp)
func (c *GraphOpenAIClient) GenerateChat(
	ctx context.Context,
	messages []ai.ChatMessage,
	opts ...ai.GenerateOption,
) (string, error) {
	client := c.ChatClient

	options := ai.GenerateOptions{
		Model:         c.descriptionModel,
		SystemPrompts: []string{},
		Temperature:   0.2,
		Thinking:      "",
	}
	for _, o := range opts {
		o(&options)
	}

	msgs := make([]openai.ChatCompletionMessageParamUnion, 0)
	for _, message := range options.SystemPrompts {
		msgs = append(msgs, openai.SystemMessage(message))
	}
	for _, message := range messages {
		switch message.Role {
		case "user":
			msgs = append(msgs, openai.UserMessage(message.Message))
		case "assistant":
			msgs = append(msgs, openai.AssistantMessage(message.Message))
		}
	}

	body := openai.ChatCompletionNewParams{
		Model:       openai.ChatModel(options.Model),
		Messages:    msgs,
		Temperature: openai.Float(options.Temperature),
	}

	if options.Thinking != "" {
		// Needed fix for gpt-5 models as they dont support temperature other than 1.0 when reasoning is enabled
		if c.chatURL == "" {
			body.Temperature = openai.Float(1.0)
		}
		body.ReasoningEffort = shared.ReasoningEffort(options.Thinking)
	}

	start := time.Now()
	response, err := client.Chat.Completions.New(ctx, body)
	if err != nil {
		return "", err
	}
	duration := time.Since(start).Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  int(response.Usage.PromptTokens),
		OutputTokens: int(response.Usage.CompletionTokens),
		TotalTokens:  int(response.Usage.TotalTokens),
		DurationMs:   duration,
	}
	c.modifyMetrics(metrics)

	return response.Choices[0].Message.Content, nil
}

// GenerateChatStream sends a multi-turn chat conversation to the model
// and returns a channel that streams the assistant’s reply incrementally.
//
// This is useful for real-time applications such as UIs or CLIs where
// partial responses should be displayed as they arrive.
//
// The returned channel will be closed automatically when the stream ends
// or the context is canceled.
//
// Example:
//
//	stream, err := client.GenerateChatStream(ctx, "You are a helpful assistant.", msgs, 0.7)
//	if err != nil {
//		log.Fatal(err)
//	}
//	for token := range stream {
//		fmt.Print(token)
//	}
func (c *GraphOpenAIClient) GenerateChatStream(
	ctx context.Context,
	messages []ai.ChatMessage,
	opts ...ai.GenerateOption,
) (<-chan ai.StreamEvent, error) {
	client := c.ChatClient

	options := ai.GenerateOptions{
		Model:         c.descriptionModel,
		SystemPrompts: []string{},
		Temperature:   0.2,
		Thinking:      "",
	}
	for _, o := range opts {
		o(&options)
	}

	msgs := make([]openai.ChatCompletionMessageParamUnion, 0)
	for _, message := range options.SystemPrompts {
		msgs = append(msgs, openai.SystemMessage(message))
	}
	for _, message := range messages {
		switch message.Role {
		case "user":
			msgs = append(msgs, openai.UserMessage(message.Message))
		case "assistant":
			msgs = append(msgs, openai.AssistantMessage(message.Message))
		}
	}

	body := openai.ChatCompletionNewParams{
		Model:       openai.ChatModel(options.Model),
		Messages:    msgs,
		Temperature: openai.Float(options.Temperature),
		StreamOptions: openai.ChatCompletionStreamOptionsParam{
			IncludeUsage: openai.Bool(true),
		},
	}

	if options.Thinking != "" {
		// Needed fix for gpt-5 models as they dont support temperature other than 1.0 when reasoning is enabled
		if c.chatURL == "" {
			body.Temperature = openai.Float(1.0)
		}
		body.ReasoningEffort = shared.ReasoningEffort(options.Thinking)
	}

	start := time.Now()
	stream := client.Chat.Completions.NewStreaming(ctx, body)
	contentChan := make(chan ai.StreamEvent, 10)

	go func() {
		defer close(contentChan)
		defer stream.Close()

		acc := openai.ChatCompletionAccumulator{}
		contentStarted := false

		for stream.Next() {
			chunk := stream.Current()
			acc.AddChunk(chunk)

			if len(chunk.Choices) > 0 {
				if !contentStarted {
					var reasoningContent string
					if reasoningField, ok := chunk.Choices[0].Delta.JSON.ExtraFields["reasoning"]; ok && reasoningField.Raw() != "" {
						var decoded string
						if err := json.Unmarshal([]byte(reasoningField.Raw()), &decoded); err == nil {
							reasoningContent = decoded
						}
					}

					if reasoningContent != "" {
						select {
						case contentChan <- ai.StreamEvent{Type: "step", Step: "thinking", Reasoning: reasoningContent}:
						case <-ctx.Done():
							stream.Close()
							return
						}
					}
				}

				// Regular content
				if chunk.Choices[0].Delta.Content != "" {
					contentStarted = true
					select {
					case contentChan <- ai.StreamEvent{Type: "content", Content: chunk.Choices[0].Delta.Content}:
					case <-ctx.Done():
						stream.Close()
						return
					}
				}
			}
		}

		duration := time.Since(start).Milliseconds()
		metrics := ai.ModelMetrics{
			InputTokens:  int(acc.Usage.PromptTokens),
			OutputTokens: int(acc.Usage.CompletionTokens),
			TotalTokens:  int(acc.Usage.TotalTokens),
			DurationMs:   duration,
		}
		c.modifyMetrics(metrics)
	}()

	return contentChan, nil
}

// LoadModel is a no-op for OpenAI as models are loaded on-demand.
// It exists to satisfy the GraphAIClient interface.
func (c *GraphOpenAIClient) LoadModel(ctx context.Context, opts ...ai.GenerateOption) error {
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
func (c *GraphOpenAIClient) GenerateCompletionWithTools(
	ctx context.Context,
	prompt string,
	tools []ai.Tool,
	opts ...ai.GenerateOption,
) (string, error) {
	client := c.ChatClient

	options := ai.GenerateOptions{
		Model:       c.descriptionModel,
		Temperature: 0.3,
		Thinking:    "",
	}
	for _, o := range opts {
		o(&options)
	}

	maxRounds := 10
	messages := []openai.ChatCompletionMessageParamUnion{
		openai.UserMessage(prompt),
	}

	openaiTools := make([]openai.ChatCompletionToolUnionParam, len(tools))
	for i, tool := range tools {
		openaiTools[i] = openai.ChatCompletionFunctionTool(openai.FunctionDefinitionParam{
			Name:        tool.Name,
			Description: openai.String(tool.Description),
			Parameters:  tool.Parameters,
		})
	}

	for range maxRounds {
		body := openai.ChatCompletionNewParams{
			Model:       openai.ChatModel(options.Model),
			Messages:    messages,
			Tools:       openaiTools,
			Temperature: openai.Float(options.Temperature),
		}

		if options.Thinking != "" {
			// Needed fix for gpt-5 models as they dont support temperature other than 1.0 when reasoning is enabled
			if c.chatURL == "" {
				body.Temperature = openai.Float(1.0)
			}
			body.ReasoningEffort = shared.ReasoningEffort(options.Thinking)
		}

		start := time.Now()
		response, err := client.Chat.Completions.New(ctx, body)
		if err != nil {
			return "", err
		}
		duration := time.Since(start).Milliseconds()

		metrics := ai.ModelMetrics{
			InputTokens:  int(response.Usage.PromptTokens),
			OutputTokens: int(response.Usage.CompletionTokens),
			TotalTokens:  int(response.Usage.TotalTokens),
			DurationMs:   duration,
		}
		c.modifyMetrics(metrics)

		if len(response.Choices[0].Message.ToolCalls) == 0 {
			return response.Choices[0].Message.Content, nil
		}

		messages = append(messages, response.Choices[0].Message.ToParam())

		for _, tc := range response.Choices[0].Message.ToolCalls {
			ftc := tc.AsFunction()

			var handler ai.ToolHandler
			for _, tool := range tools {
				if tool.Name == ftc.Function.Name {
					handler = tool.Handler
					break
				}
			}

			if handler == nil {
				return "", fmt.Errorf("no handler found for tool: %s", ftc.Function.Name)
			}

			result, err := handler(ctx, ftc.Function.Arguments)
			if err != nil {
				return "", fmt.Errorf("tool %s failed: %w", ftc.Function.Name, err)
			}

			messages = append(messages, openai.ToolMessage(result, ftc.ID))
		}
	}

	return "", fmt.Errorf("max tool rounds (%d) exceeded", maxRounds)
}

// GenerateChatWithTools sends a multi-turn conversation with tools that the model can call.
// Tool calls are automatically executed and their results fed back until the model produces
// a final response without tool calls, or until the maximum rounds (20) is reached.
func (c *GraphOpenAIClient) GenerateChatWithTools(
	ctx context.Context,
	messages []ai.ChatMessage,
	tools []ai.Tool,
	opts ...ai.GenerateOption,
) (string, error) {
	client := c.ChatClient

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
	msgs := make([]openai.ChatCompletionMessageParamUnion, 0)
	for _, message := range options.SystemPrompts {
		msgs = append(msgs, openai.SystemMessage(message))
	}
	for _, message := range messages {
		switch message.Role {
		case "user":
			msgs = append(msgs, openai.UserMessage(message.Message))
		case "assistant":
			msgs = append(msgs, openai.AssistantMessage(message.Message))
		}
	}

	openaiTools := make([]openai.ChatCompletionToolUnionParam, len(tools))
	for i, tool := range tools {
		openaiTools[i] = openai.ChatCompletionFunctionTool(openai.FunctionDefinitionParam{
			Name:        tool.Name,
			Description: openai.String(tool.Description),
			Parameters:  tool.Parameters,
		})
	}

	for range maxRounds {
		body := openai.ChatCompletionNewParams{
			Model:       openai.ChatModel(options.Model),
			Messages:    msgs,
			Tools:       openaiTools,
			Temperature: openai.Float(options.Temperature),
		}

		if options.Thinking != "" {
			// Needed fix for gpt-5 models as they dont support temperature other than 1.0 when reasoning is enabled
			if c.chatURL == "" {
				body.Temperature = openai.Float(1.0)
			}
			body.ReasoningEffort = shared.ReasoningEffort(options.Thinking)
		}

		start := time.Now()
		response, err := client.Chat.Completions.New(ctx, body)
		if err != nil {
			return "", err
		}
		duration := time.Since(start).Milliseconds()

		metrics := ai.ModelMetrics{
			InputTokens:  int(response.Usage.PromptTokens),
			OutputTokens: int(response.Usage.CompletionTokens),
			TotalTokens:  int(response.Usage.TotalTokens),
			DurationMs:   duration,
		}
		c.modifyMetrics(metrics)

		if len(response.Choices[0].Message.ToolCalls) == 0 {
			return response.Choices[0].Message.Content, nil
		}

		msgs = append(msgs, response.Choices[0].Message.ToParam())

		for _, tc := range response.Choices[0].Message.ToolCalls {
			ftc := tc.AsFunction()

			var handler ai.ToolHandler
			for _, tool := range tools {
				if tool.Name == ftc.Function.Name {
					handler = tool.Handler
					break
				}
			}

			if handler == nil {
				return "", fmt.Errorf("no handler found for tool: %s", ftc.Function.Name)
			}

			result, err := handler(ctx, ftc.Function.Arguments)
			if err != nil {
				return "", fmt.Errorf("tool %s failed: %w", ftc.Function.Name, err)
			}

			msgs = append(msgs, openai.ToolMessage(result, ftc.ID))
		}
	}

	return "", fmt.Errorf("max tool rounds (%d) exceeded", maxRounds)
}

// GenerateChatStreamWithTools sends a multi-turn conversation with tools and streams the final response.
// Tool calls are processed in non-streaming mode until the model is ready to produce its final
// response, which is then streamed incrementally through the returned channel.
func (c *GraphOpenAIClient) GenerateChatStreamWithTools(
	ctx context.Context,
	messages []ai.ChatMessage,
	tools []ai.Tool,
	opts ...ai.GenerateOption,
) (<-chan ai.StreamEvent, error) {
	client := c.ChatClient

	options := ai.GenerateOptions{
		Model:         c.descriptionModel,
		SystemPrompts: []string{},
		Temperature:   0.2,
		Thinking:      "",
	}
	for _, o := range opts {
		o(&options)
	}

	msgs := make([]openai.ChatCompletionMessageParamUnion, 0)
	for _, message := range options.SystemPrompts {
		msgs = append(msgs, openai.SystemMessage(message))
	}
	for _, message := range messages {
		switch message.Role {
		case "user":
			msgs = append(msgs, openai.UserMessage(message.Message))
		case "assistant":
			msgs = append(msgs, openai.AssistantMessage(message.Message))
		}
	}

	openaiTools := make([]openai.ChatCompletionToolUnionParam, len(tools))
	for i, tool := range tools {
		openaiTools[i] = openai.ChatCompletionFunctionTool(openai.FunctionDefinitionParam{
			Name:        tool.Name,
			Description: openai.String(tool.Description),
			Parameters:  tool.Parameters,
		})
	}

	maxRounds := 20
	contentChan := make(chan ai.StreamEvent, 10)
	go func() {
		defer close(contentChan)

		body := openai.ChatCompletionNewParams{
			Model:       openai.ChatModel(options.Model),
			Messages:    msgs,
			Tools:       openaiTools,
			Temperature: openai.Float(options.Temperature),
			StreamOptions: openai.ChatCompletionStreamOptionsParam{
				IncludeUsage: openai.Bool(true),
			},
		}

		if options.Thinking != "" {
			// Needed fix for gpt-5 models as they dont support temperature other than 1.0 when reasoning is enabled
			if c.chatURL == "" {
				body.Temperature = openai.Float(1.0)
			}
			body.ReasoningEffort = shared.ReasoningEffort(options.Thinking)
		}

		for range maxRounds {
			body.Messages = msgs

			start := time.Now()
			stream := client.Chat.Completions.NewStreaming(ctx, body)

			acc := openai.ChatCompletionAccumulator{}
			hasContent := false
			stop := false

			for stream.Next() {
				chunk := stream.Current()
				acc.AddChunk(chunk)

				if len(chunk.Choices) > 0 {
					if reasoningField, ok := chunk.Choices[0].Delta.JSON.ExtraFields["reasoning"]; ok && reasoningField.Raw() != "" {
						var decoded string
						if err := json.Unmarshal([]byte(reasoningField.Raw()), &decoded); err == nil && decoded != "" {
							select {
							case contentChan <- ai.StreamEvent{Type: "step", Step: "thinking", Reasoning: decoded}:
							case <-ctx.Done():
								stop = true
								stream.Close()
								return
							}
						}
					}

					if chunk.Choices[0].Delta.Content != "" {
						hasContent = true
						select {
						case contentChan <- ai.StreamEvent{Type: "content", Content: chunk.Choices[0].Delta.Content}:
						case <-ctx.Done():
							stop = true
							stream.Close()
							return
						}
					}
				}
			}

			stream.Close()

			duration := time.Since(start).Milliseconds()
			metrics := ai.ModelMetrics{
				InputTokens:  int(acc.Usage.PromptTokens),
				OutputTokens: int(acc.Usage.CompletionTokens),
				TotalTokens:  int(acc.Usage.TotalTokens),
				DurationMs:   duration,
			}
			c.modifyMetrics(metrics)

			if stop {
				break
			}

			if len(acc.Choices) > 0 && len(acc.Choices[0].Message.ToolCalls) > 0 {
				var toolResults []struct {
					ID     string
					Result string
				}

				for _, tc := range acc.Choices[0].Message.ToolCalls {
					functionName := tc.Function.Name
					functionArgs := tc.Function.Arguments

					var handler ai.ToolHandler
					for _, t := range tools {
						if t.Name == functionName {
							handler = t.Handler
							break
						}
					}

					if handler == nil {
						logger.Error("[Tool] no handler found", "tool", functionName)
						return
					}

					select {
					case contentChan <- ai.StreamEvent{Type: "step", Step: functionName}:
					case <-ctx.Done():
						return
					}

					result, err := handler(ctx, functionArgs)
					if err != nil {
						logger.Error("[Tool] failed", "tool", functionName, "err", err)
						return
					}

					toolResults = append(toolResults, struct {
						ID     string
						Result string
					}{tc.ID, result})
				}

				msgs = append(msgs, acc.Choices[0].Message.ToParam())

				for _, tr := range toolResults {
					msgs = append(msgs, openai.ToolMessage(tr.Result, tr.ID))
				}

				continue
			}

			if hasContent {
				break
			}

			break
		}
	}()

	return contentChan, nil
}
