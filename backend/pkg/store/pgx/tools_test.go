package pgx

import (
	"testing"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
)

func TestGetToolLists_ExposeExpectedExecutionModes(t *testing.T) {
	serverTools := GetServerToolList(nil, nil, "project-1", "user-1", nil, false)
	if len(serverTools) == 0 {
		t.Fatal("expected server tools")
	}
	for _, tool := range serverTools {
		if tool.NormalizedToolExecution() != ai.ToolExecutionServer {
			t.Fatalf("expected server tool execution, got %q for %q", tool.NormalizedToolExecution(), tool.Name)
		}
	}

	clientTools := GetClientToolList()
	if len(clientTools) == 0 {
		t.Fatal("expected client tools")
	}
	for _, tool := range clientTools {
		if tool.NormalizedToolExecution() != ai.ToolExecutionClient {
			t.Fatalf("expected client tool execution, got %q for %q", tool.NormalizedToolExecution(), tool.Name)
		}
	}

	combinedTools := GetCombinedToolList(nil, nil, "project-1", "user-1", nil, false)
	if len(combinedTools) != len(serverTools)+len(clientTools) {
		t.Fatalf("expected %d combined tools, got %d", len(serverTools)+len(clientTools), len(combinedTools))
	}

	hasClientTool := false
	for _, tool := range combinedTools {
		if tool.NormalizedToolExecution() == ai.ToolExecutionClient {
			hasClientTool = true
			break
		}
	}
	if !hasClientTool {
		t.Fatal("expected combined tool list to include at least one client tool")
	}
}
