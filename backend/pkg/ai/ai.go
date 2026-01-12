package ai

import (
	"context"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
)

// ToolHandler is a function that executes a tool call and returns its result.
// The arguments parameter contains the JSON-encoded arguments from the AI model.
type ToolHandler func(ctx context.Context, arguments string) (string, error)

// Tool defines a function that can be called by an AI model during generation.
type Tool struct {
	Name        string         // Unique identifier for the tool
	Description string         // Human-readable description of what the tool does
	Parameters  map[string]any // JSON Schema defining the tool's input parameters
	Handler     ToolHandler    // Function to execute when the tool is called
}

// ToolCall represents a request from the AI model to invoke a specific tool.
type ToolCall struct {
	ID        string // Unique identifier for this tool call
	Name      string // Name of the tool to invoke
	Arguments string // JSON-encoded arguments for the tool
}

// ChatMessage represents a single message in a chat conversation.
// It is used when generating multi-turn chat completions.
//
// Role must be one of:
//   - "user"      → a user-provided message
//   - "assistant" → a message from the AI assistant
type ChatMessage struct {
	Message string `json:"message"`
	Role    string `json:"role"`
}

// GenerateOptions holds configuration for AI generation requests.
type GenerateOptions struct {
	Model         string   // Model identifier to use for generation
	SystemPrompts []string // System prompts prepended to the request
	Temperature   float64  // Sampling temperature (0.0-2.0)
	Thinking      string   // Extended thinking mode configuration
}

// ModelMetrics contains performance metrics from AI model operations.
type ModelMetrics struct {
	InputTokens    int     `json:"input_tokens"`
	OutputTokens   int     `json:"output_tokens"`
	TotalTokens    int     `json:"total_tokens"`
	DurationMs     int64   `json:"duration_ms"`
	WallClockMs    int64   `json:"wall_clock_ms"`
	TokenPerSecond float32 `json:"tokens_per_second"`
}

// StreamEvent represents an event in a streaming response
type StreamEvent struct {
	Type      string // "step" | "content"
	Step      string // step name (when Type="step")
	Content   string // text content (when Type="content")
	Reasoning string // reasoning content (when Step="thinking")
}

// GenerateOption is a functional option for configuring AI generation requests.
type GenerateOption func(*GenerateOptions)

// WithModel returns a GenerateOption that sets the model to use for generation.
func WithModel(model string) GenerateOption {
	return func(o *GenerateOptions) {
		o.Model = model
	}
}

// WithSystemPrompts returns a GenerateOption that sets the system prompts
// to prepend to the generation request.
func WithSystemPrompts(prompts ...string) GenerateOption {
	return func(o *GenerateOptions) {
		o.SystemPrompts = prompts
	}
}

// WithTemperature returns a GenerateOption that sets the sampling temperature.
// Higher values (e.g., 1.0) produce more random outputs, while lower values
// (e.g., 0.2) make outputs more focused and deterministic.
func WithTemperature(temp float64) GenerateOption {
	return func(o *GenerateOptions) {
		o.Temperature = temp
	}
}

// WithThinking returns a GenerateOption that enables extended thinking mode.
// The thinking parameter specifies the thinking budget or mode configuration.
func WithThinking(thinking string) GenerateOption {
	return func(o *GenerateOptions) {
		o.Thinking = thinking
	}
}

// GraphAIClient defines the interface for AI operations used in graph construction and querying.
// Implementations handle text generation, embeddings, image description, and audio transcription.
type GraphAIClient interface {
	GenerateCompletion(
		ctx context.Context,
		prompt string,
		opts ...GenerateOption,
	) (string, error)
	GenerateCompletionWithFormat(
		ctx context.Context,
		name string,
		description string,
		prompt string,
		out any,
		opts ...GenerateOption,
	) error
	GenerateCompletionWithTools(
		ctx context.Context,
		prompt string,
		tools []Tool,
		opts ...GenerateOption,
	) (string, error)

	GenerateChat(
		ctx context.Context,
		messages []ChatMessage,
		opts ...GenerateOption,
	) (string, error)
	GenerateChatWithTools(
		ctx context.Context,
		messages []ChatMessage,
		tools []Tool,
		opts ...GenerateOption,
	) (string, error)

	GenerateChatStream(
		ctx context.Context,
		messages []ChatMessage,
		opts ...GenerateOption,
	) (<-chan StreamEvent, error)
	GenerateChatStreamWithTools(
		ctx context.Context,
		messages []ChatMessage,
		tools []Tool,
		opts ...GenerateOption,
	) (<-chan StreamEvent, error)

	GenerateEmbedding(ctx context.Context, input []byte) ([]float32, error)
	GenerateImageDescription(
		ctx context.Context,
		prompt string,
		base64 loader.GraphBase64,
	) (string, error)
	GenerateAudioTranscription(
		ctx context.Context,
		audio []byte,
		language string,
	) (string, error)

	LoadModel(ctx context.Context, opts ...GenerateOption) error
	ResetMetrics()
	GetMetrics() ModelMetrics
}

// GraphAIClientWithTypeTracking extends GraphAIClient with per-type request tracking
type GraphAIClientWithTypeTracking interface {
	GraphAIClient
	SetExpectedRequestsForType(requestType string, count int)
}
