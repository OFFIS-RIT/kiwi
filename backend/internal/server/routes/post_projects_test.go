package routes

import (
	"context"
	"errors"
	"testing"

	serverutil "github.com/OFFIS-RIT/kiwi/backend/internal/server/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
)

type blockingQueryClientStub struct {
	localCalled   int
	agenticCalled int
	tools         []ai.Tool
	localResp     string
	agenticResp   string
	localErr      error
	agenticErr    error
}

func (s *blockingQueryClientStub) QueryLocal(_ context.Context, _ []ai.ChatMessage) (string, error) {
	s.localCalled++
	return s.localResp, s.localErr
}

func (s *blockingQueryClientStub) QueryAgentic(_ context.Context, _ []ai.ChatMessage, tools []ai.Tool) (string, error) {
	s.agenticCalled++
	s.tools = append([]ai.Tool(nil), tools...)
	return s.agenticResp, s.agenticErr
}

func TestExecuteBlockingProjectQuery_PassesToolsUnchanged(t *testing.T) {
	stub := &blockingQueryClientStub{agenticResp: "agentic answer"}
	tools := []ai.Tool{
		{Name: "server-default"},
		{Name: "server-explicit", Execution: ai.ToolExecutionServer},
		{Name: "client", Execution: ai.ToolExecutionClient},
	}

	_, err := serverutil.ExecuteBlockingProjectQuery(context.Background(), stub, "agentic", nil, tools)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(stub.tools) != len(tools) {
		t.Fatalf("expected %d tools, got %d", len(tools), len(stub.tools))
	}
	for i := range tools {
		if stub.tools[i].Name != tools[i].Name {
			t.Fatalf("expected tool %d to be %q, got %q", i, tools[i].Name, stub.tools[i].Name)
		}
	}
}

func TestExecuteBlockingProjectQuery_UsesQueryLocalForNormalAndFallback(t *testing.T) {
	tests := []struct {
		name string
		mode string
	}{
		{name: "normal mode", mode: "normal"},
		{name: "fallback mode", mode: ""},
		{name: "unknown mode", mode: "unexpected"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := &blockingQueryClientStub{localResp: "local answer"}

			resp, err := serverutil.ExecuteBlockingProjectQuery(context.Background(), stub, tt.mode, nil, []ai.Tool{{Name: "client", Execution: ai.ToolExecutionClient}})
			if err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
			if resp != "local answer" {
				t.Fatalf("expected local response, got %q", resp)
			}
			if stub.localCalled != 1 {
				t.Fatalf("expected QueryLocal to be called once, got %d", stub.localCalled)
			}
			if stub.agenticCalled != 0 {
				t.Fatalf("expected QueryAgentic not to be called, got %d", stub.agenticCalled)
			}
		})
	}
}

func TestExecuteBlockingProjectQuery_UsesQueryAgentic(t *testing.T) {
	stub := &blockingQueryClientStub{agenticResp: "agentic answer"}
	tools := []ai.Tool{
		{Name: "server", Execution: ai.ToolExecutionServer},
		{Name: "client", Execution: ai.ToolExecutionClient},
		{Name: "implicit-server"},
	}

	resp, err := serverutil.ExecuteBlockingProjectQuery(context.Background(), stub, "agentic", nil, tools)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if resp != "agentic answer" {
		t.Fatalf("expected agentic response, got %q", resp)
	}
	if stub.localCalled != 0 {
		t.Fatalf("expected QueryLocal not to be called, got %d", stub.localCalled)
	}
	if stub.agenticCalled != 1 {
		t.Fatalf("expected QueryAgentic to be called once, got %d", stub.agenticCalled)
	}
	if len(stub.tools) != 3 {
		t.Fatalf("expected 3 forwarded tools, got %d", len(stub.tools))
	}
	if stub.tools[0].Name != "server" {
		t.Fatalf("expected first forwarded tool to be server, got %q", stub.tools[0].Name)
	}
	if stub.tools[1].Name != "client" {
		t.Fatalf("expected second forwarded tool to be client, got %q", stub.tools[1].Name)
	}
	if stub.tools[2].Name != "implicit-server" {
		t.Fatalf("expected third forwarded tool to be implicit-server, got %q", stub.tools[2].Name)
	}
}

func TestExecuteBlockingProjectQuery_PropagatesErrors(t *testing.T) {
	expectedErr := errors.New("boom")
	stub := &blockingQueryClientStub{agenticErr: expectedErr}

	_, err := serverutil.ExecuteBlockingProjectQuery(context.Background(), stub, "agentic", nil, nil)
	if !errors.Is(err, expectedErr) {
		t.Fatalf("expected %v, got %v", expectedErr, err)
	}
}
