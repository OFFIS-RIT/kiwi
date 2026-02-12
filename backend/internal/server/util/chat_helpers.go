package util

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

const defaultPendingToolResult = "No answer"

func GetPendingToolCall(historyRows []pgdb.ChatMessage) *pgdb.ChatMessage {
	if len(historyRows) == 0 {
		return nil
	}

	last := historyRows[len(historyRows)-1]
	if last.Role != "assistant_tool_call" {
		return nil
	}
	if strings.TrimSpace(last.ToolCallID) == "" {
		return nil
	}

	pending := last
	return &pending
}

func AppendPendingToolResult(
	ctx context.Context,
	q *pgdb.Queries,
	chatID int64,
	chatHistory *[]ai.ChatMessage,
	pending *pgdb.ChatMessage,
	toolID string,
	prompt string,
) (bool, error) {
	if pending == nil {
		return false, nil
	}

	result := defaultPendingToolResult
	usedPromptAsToolResult := false
	if strings.TrimSpace(toolID) != "" {
		if toolID != pending.ToolCallID {
			return false, fmt.Errorf("tool_id mismatch: expected %s, got %s", pending.ToolCallID, toolID)
		}
		result = prompt
		usedPromptAsToolResult = true
	}

	toolResult := ai.ChatMessage{
		Role:          "tool",
		Message:       result,
		ToolCallID:    pending.ToolCallID,
		ToolName:      pending.ToolName,
		ToolExecution: ai.ToolExecution(pending.ToolExecution),
	}
	*chatHistory = append(*chatHistory, toolResult)

	if err := AppendChatMessage(ctx, q, chatID, toolResult); err != nil {
		return false, err
	}

	return usedPromptAsToolResult, nil
}

func AppendChatMessage(ctx context.Context, q *pgdb.Queries, chatID int64, message ai.ChatMessage) error {
	content := sanitizePostgresText(message.Message)
	toolCallID := sanitizePostgresText(message.ToolCallID)
	toolName := sanitizePostgresText(message.ToolName)
	toolArguments := sanitizePostgresText(message.ToolArguments)
	cleanReasoning := sanitizePostgresText(message.Reasoning)

	reasoningValue := pgtype.Text{}
	if strings.TrimSpace(cleanReasoning) != "" {
		reasoningValue = pgtype.Text{String: cleanReasoning, Valid: true}
	}

	if err := q.AddChatMessage(ctx, pgdb.AddChatMessageParams{
		ChatID:        chatID,
		Role:          message.Role,
		Content:       content,
		ToolCallID:    toolCallID,
		ToolName:      toolName,
		ToolArguments: toolArguments,
		ToolExecution: normalizeToolExecution(message.Role, message.ToolExecution),
		Reasoning:     reasoningValue,
	}); err != nil {
		return err
	}

	return q.TouchUserChat(ctx, chatID)
}

func AppendAssistantChatMessage(
	ctx context.Context,
	q *pgdb.Queries,
	chatID int64,
	content string,
	reasoning string,
	metrics *ai.ModelMetrics,
) error {
	cleanContent := sanitizePostgresText(content)
	cleanReasoning := sanitizePostgresText(reasoning)

	reasoningValue := pgtype.Text{}
	if strings.TrimSpace(cleanReasoning) != "" {
		reasoningValue = pgtype.Text{String: cleanReasoning, Valid: true}
	}

	var encodedMetrics []byte
	if metrics != nil {
		metricsJSON, err := json.Marshal(metrics)
		if err != nil {
			return err
		}
		encodedMetrics = metricsJSON
	}

	if err := q.AddChatMessage(ctx, pgdb.AddChatMessageParams{
		ChatID:        chatID,
		Role:          "assistant",
		Content:       cleanContent,
		ToolExecution: "",
		Reasoning:     reasoningValue,
		Metrics:       encodedMetrics,
	}); err != nil {
		return err
	}

	return q.TouchUserChat(ctx, chatID)
}

func normalizeToolExecution(role string, execution ai.ToolExecution) string {
	if role != "assistant_tool_call" && role != "tool" {
		return ""
	}

	if execution == ai.ToolExecutionClient {
		return string(ai.ToolExecutionClient)
	}

	return string(ai.ToolExecutionServer)
}

func sanitizePostgresText(value string) string {
	if value == "" {
		return value
	}

	sanitized := strings.ToValidUTF8(value, "")
	return strings.ReplaceAll(sanitized, "\x00", "")
}

func BuildConversationTitle(prompt string) string {
	trimmed := strings.TrimSpace(prompt)
	if trimmed == "" {
		return "New conversation"
	}

	const maxTitleLength = 120
	if len(trimmed) <= maxTitleLength {
		return trimmed
	}

	return trimmed[:maxTitleLength]
}

func WriteSSEEvent(c echo.Context, event string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	if _, err := fmt.Fprintf(c.Response(), "event: %s\n", event); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(c.Response(), "data: %s\n\n", data); err != nil {
		return err
	}

	c.Response().Flush()
	return nil
}
