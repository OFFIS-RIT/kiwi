package routes

import (
	"database/sql"
	"fmt"
	"net/http"
	"slices"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"

	"github.com/labstack/echo/v4"
)

func DeleteUserFromGroupHandler(c echo.Context) error {
	type deleteGroupData struct {
		GroupID int64   `param:"id" validate:"required,numeric"`
		UserIDs []int64 `json:"user_id" validate:"required,numeric"`
	}

	type deleteGroupResponse struct {
		Message string            `json:"message"`
		Users   *[]pgdb.GroupUser `json:"users,omitempty"`
	}

	data := new(deleteGroupData)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, deleteGroupResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, deleteGroupResponse{
			Message: "Invalid request params",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		return c.JSON(http.StatusBadRequest, deleteGroupResponse{
			Message: "Internal server error",
		})
	}
	defer tx.Rollback(ctx)
	q := pgdb.New(conn)
	qtx := q.WithTx(tx)

	if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInGroup(ctx, pgdb.IsUserInGroupParams{
			GroupID: data.GroupID,
			UserID:  user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, deleteGroupResponse{
				Message: "You are not a member of this group",
			})
		}
	}

	dbUsers, err := qtx.GetGroupUsers(ctx, data.GroupID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteGroupResponse{
			Message: "Internal server error",
		})
	}
	for _, userID := range data.UserIDs {
		found := false
		for i, dbUser := range dbUsers {
			if dbUser.UserID == user.UserID {
				break
			}
			if dbUser.UserID == userID {
				dbUsers = slices.Delete(dbUsers, i, i+1)
				found = true
				break
			}
		}
		if !found {
			continue
		}
		err = qtx.DeleteUserFromGroup(ctx, pgdb.DeleteUserFromGroupParams{
			GroupID: data.GroupID,
			UserID:  userID,
		})
		if err != nil {
			return c.JSON(http.StatusInternalServerError, deleteGroupResponse{
				Message: "Internal server error",
			})
		}
	}

	err = tx.Commit(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteGroupResponse{
			Message: "Internal server error",
		})
	}

	return c.JSON(http.StatusOK, deleteGroupResponse{
		Message: "Users removed from group",
		Users:   &dbUsers,
	})
}

func DeleteGroupHandler(c echo.Context) error {
	type deleteGroupParams struct {
		ID int64 `param:"id" validate:"required,numeric"`
	}

	type deleteGroupResponse struct {
		Message string `json:"message"`
	}

	params := new(deleteGroupParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteGroupResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteGroupResponse{
			Message: "Invalid request params",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteGroupResponse{
			Message: "Internal server error",
		})
	}
	defer tx.Rollback(ctx)
	q := pgdb.New(conn)
	qtx := q.WithTx(tx)

	if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInGroup(ctx, pgdb.IsUserInGroupParams{
			GroupID: params.ID,
			UserID:  user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, deleteGroupResponse{
				Message: "You are not a member of this group",
			})
		}
	}

	projects, err := qtx.GetProjectsByGroup(ctx, sql.NullInt64{Int64: params.ID, Valid: true})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteGroupResponse{
			Message: "Internal server error",
		})
	}

	err = qtx.DeleteGroup(ctx, params.ID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteGroupResponse{
			Message: "Internal server error",
		})
	}

	err = tx.Commit(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteGroupResponse{
			Message: "Internal server error",
		})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	for _, project := range projects {
		storage.DeleteFolder(ctx, s3Client, fmt.Sprintf("projects/%d", project.ID))
	}

	return c.JSON(http.StatusOK, deleteGroupResponse{
		Message: "Group deleted",
	})
}
