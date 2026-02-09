package routes

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	serverutil "github.com/OFFIS-RIT/kiwi/backend/internal/server/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

func GetUserChatsHandler(c echo.Context) error {
	type getUserChatsParams struct {
		ProjectID int64 `param:"id" validate:"required,numeric"`
	}

	type responseData struct {
		ConversationID string `json:"conversation_id"`
		Title          string `json:"title"`
	}

	params := new(getUserChatsParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid request params"})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid request params"})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			ID:     params.ProjectID,
			UserID: user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, map[string]string{"message": "Unauthorized"})
		}
	}

	_, err := q.GetGroupByProjectId(ctx, params.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, map[string]string{"message": "Project or Group not found"})
		}

		logger.Error("Failed to get group", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}

	chats, err := q.GetUserChatsByProject(ctx, pgdb.GetUserChatsByProjectParams{
		UserID:    user.UserID,
		ProjectID: params.ProjectID,
	})
	if err != nil {
		logger.Error("Failed to get user chats", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}

	resp := make([]responseData, 0, len(chats))
	for _, chat := range chats {
		resp = append(resp, responseData{
			ConversationID: chat.PublicID,
			Title:          chat.Title,
		})
	}

	return c.JSON(http.StatusOK, resp)
}

func GetChatHandler(c echo.Context) error {
	type getChatParams struct {
		ProjectID      int64  `param:"id" validate:"required,numeric"`
		ConversationID string `param:"conversation_id" validate:"required"`
	}

	type chatMessage struct {
		Role      string                    `json:"role"`
		Message   string                    `json:"message"`
		Reasoning *string                   `json:"reasoning,omitempty"`
		Metrics   *ai.ModelMetrics          `json:"metrics,omitempty"`
		Data      []serverutil.CitationData `json:"data,omitempty"`
	}

	type getChatResponse struct {
		ConversationID string        `json:"conversation_id"`
		Title          string        `json:"title"`
		Messages       []chatMessage `json:"messages"`
	}

	params := new(getChatParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid request params"})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid request params"})
	}

	params.ConversationID = strings.TrimSpace(params.ConversationID)
	if params.ConversationID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "conversation_id is required"})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			ID:     params.ProjectID,
			UserID: user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, map[string]string{"message": "Unauthorized"})
		}
	}

	_, err := q.GetGroupByProjectId(ctx, params.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, map[string]string{"message": "Project or Group not found"})
		}

		logger.Error("Failed to get group", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}

	conversation, err := q.GetUserChatByPublicIDAndProject(ctx, pgdb.GetUserChatByPublicIDAndProjectParams{
		PublicID:  params.ConversationID,
		UserID:    user.UserID,
		ProjectID: params.ProjectID,
	})
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, map[string]string{"message": "Conversation not found"})
		}

		logger.Error("Failed to get conversation", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}

	historyRows, err := q.GetChatMessagesByChatIDWithoutToolCalls(ctx, conversation.ID)
	if err != nil {
		logger.Error("Failed to load conversation history", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}

	assistantMessages := make([]pgdb.ChatMessage, 0, len(historyRows))
	for _, message := range historyRows {
		if message.Role != "assistant" {
			continue
		}
		assistantMessages = append(assistantMessages, message)
	}

	resolvedCitationDataByMessageID, err := serverutil.ResolveCitationDataByMessage(ctx, q, assistantMessages)
	if err != nil {
		logger.Error("Failed to resolve citation data", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}

	messages := make([]chatMessage, 0, len(historyRows))
	for _, message := range historyRows {
		item := chatMessage{
			Role:    message.Role,
			Message: message.Content,
		}

		if message.Reasoning.Valid {
			reasoning := message.Reasoning.String
			item.Reasoning = &reasoning
		}

		if len(message.Metrics) > 0 {
			metrics := ai.ModelMetrics{}
			if err := json.Unmarshal(message.Metrics, &metrics); err != nil {
				logger.Error("Failed to decode assistant metrics", "conversation_id", conversation.PublicID, "message_id", message.ID, "err", err)
			} else {
				item.Metrics = &metrics
			}
		}

		if citationData, ok := resolvedCitationDataByMessageID[message.ID]; ok {
			item.Data = citationData
		}

		messages = append(messages, item)
	}

	return c.JSON(http.StatusOK, getChatResponse{
		ConversationID: conversation.PublicID,
		Title:          conversation.Title,
		Messages:       messages,
	})
}
