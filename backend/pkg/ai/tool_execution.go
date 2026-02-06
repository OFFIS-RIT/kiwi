package ai

// ToolExecution defines where a tool is executed.
//
//   - ToolExecutionServer: executed by the backend loop immediately.
//   - ToolExecutionClient: returned to the caller so the client can execute it
//     and send back a tool result in a follow-up request.
type ToolExecution string

const (
	ToolExecutionServer ToolExecution = "server"
	ToolExecutionClient ToolExecution = "client"
)

// NormalizedToolExecution returns a normalized execution mode where empty or
// unknown values default to server execution.
func (t Tool) NormalizedToolExecution() ToolExecution {
	if t.Execution == ToolExecutionClient {
		return ToolExecutionClient
	}

	return ToolExecutionServer
}
