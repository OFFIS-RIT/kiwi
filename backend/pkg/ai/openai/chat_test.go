package openai

import (
	"testing"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
)

func TestCollectBlockingToolStream_AccumulatesContent(t *testing.T) {
	stream := make(chan ai.StreamEvent, 5)
	stream <- ai.StreamEvent{Type: "reasoning", Content: "thinking"}
	stream <- ai.StreamEvent{Type: "tool_call", ToolExecution: ai.ToolExecutionServer, ToolCallID: "call_1", ToolName: "search"}
	stream <- ai.StreamEvent{Type: "tool_result", ToolExecution: ai.ToolExecutionServer, ToolCallID: "call_1", ToolName: "search", ToolResult: "ok"}
	stream <- ai.StreamEvent{Type: "content", Content: "Hello"}
	stream <- ai.StreamEvent{Type: "content", Content: " world"}
	close(stream)

	result, err := collectBlockingToolStream(stream)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result != "Hello world" {
		t.Fatalf("expected accumulated content %q, got %q", "Hello world", result)
	}
}

func TestCollectBlockingToolStream_FailsOnClientToolCall(t *testing.T) {
	stream := make(chan ai.StreamEvent, 1)
	stream <- ai.StreamEvent{Type: "tool_call", ToolExecution: ai.ToolExecutionClient, ToolCallID: "call_1", ToolName: "clarify"}
	close(stream)

	_, err := collectBlockingToolStream(stream)
	if err == nil {
		t.Fatal("expected error for client tool call")
	}
	if err.Error() != "client tool call requested: clarify (call_1)" {
		t.Fatalf("unexpected error: %v", err)
	}
}
