package routes

import (
	"database/sql"
	"net/http"
	"strings"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

func DeleteChatHandler(c echo.Context) error {
	type deleteChatParams struct {
		ProjectID      int64  `param:"id" validate:"required,numeric"`
		ConversationID string `param:"conversation_id" validate:"required"`
	}

	type deleteChatResponse struct {
		Message string `json:"message"`
	}

	params := new(deleteChatParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteChatResponse{Message: "Invalid request params"})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteChatResponse{Message: "Invalid request params"})
	}

	params.ConversationID = strings.TrimSpace(params.ConversationID)
	if params.ConversationID == "" {
		return c.JSON(http.StatusBadRequest, deleteChatResponse{Message: "conversation_id is required"})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, deleteChatResponse{Message: "Unauthorized"})
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
			return c.JSON(http.StatusForbidden, deleteChatResponse{Message: "Unauthorized"})
		}
	}

	_, err := q.GetGroupByProjectId(ctx, params.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, deleteChatResponse{Message: "Project or Group not found"})
		}

		logger.Error("Failed to get group", "err", err)
		return c.JSON(http.StatusInternalServerError, deleteChatResponse{Message: "Internal server error"})
	}

	rowsAffected, err := q.DeleteUserChatByPublicIDAndProject(ctx, pgdb.DeleteUserChatByPublicIDAndProjectParams{
		PublicID:  params.ConversationID,
		UserID:    user.UserID,
		ProjectID: params.ProjectID,
	})
	if err != nil {
		logger.Error("Failed to delete conversation", "err", err)
		return c.JSON(http.StatusInternalServerError, deleteChatResponse{Message: "Internal server error"})
	}

	if rowsAffected == 0 {
		return c.JSON(http.StatusNotFound, deleteChatResponse{Message: "Conversation not found"})
	}

	return c.JSON(http.StatusOK, deleteChatResponse{Message: "Conversation deleted successfully"})
}
