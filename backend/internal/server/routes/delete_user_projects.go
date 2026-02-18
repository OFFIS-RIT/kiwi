package routes

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

// DeleteUserProjectHandler deletes a user-owned project and all its content.
func DeleteUserProjectHandler(c echo.Context) error {
	type deleteUserProjectParams struct {
		ID int64 `param:"id" validate:"required,numeric"`
	}

	type deleteUserProjectResponse struct {
		Message string `json:"message"`
	}

	params := new(deleteUserProjectParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteUserProjectResponse{Message: "Invalid request params"})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteUserProjectResponse{Message: "Invalid request params"})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteUserProjectResponse{Message: "Internal server error"})
	}
	defer tx.Rollback(ctx)

	q := pgdb.New(conn)
	qtx := q.WithTx(tx)

	project, err := qtx.GetProjectByID(ctx, params.ID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, deleteUserProjectResponse{Message: "Project not found"})
		}
		return c.JSON(http.StatusInternalServerError, deleteUserProjectResponse{Message: "Internal server error"})
	}

	if !project.UserID.Valid || project.UserID.Int64 != user.UserID {
		return c.JSON(http.StatusForbidden, deleteUserProjectResponse{Message: "You are not allowed to delete this user project"})
	}

	if err := qtx.DeleteProject(ctx, params.ID); err != nil {
		return c.JSON(http.StatusInternalServerError, deleteUserProjectResponse{Message: "Internal server error"})
	}

	if err := tx.Commit(ctx); err != nil {
		return c.JSON(http.StatusInternalServerError, deleteUserProjectResponse{Message: "Internal server error"})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	storage.DeleteFolder(ctx, s3Client, fmt.Sprintf("projects/%d", params.ID))

	return c.JSON(http.StatusOK, deleteUserProjectResponse{Message: "User project deleted"})
}
