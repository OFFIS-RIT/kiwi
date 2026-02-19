package routes

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/labstack/echo/v4"
)

// DeleteExpertProjectHandler deletes an expert graph and all its content. Admin only.
func DeleteExpertProjectHandler(c echo.Context) error {
	type deleteExpertProjectParams struct {
		ID int64 `param:"id" validate:"required,numeric"`
	}

	type deleteExpertProjectResponse struct {
		Message string `json:"message"`
	}

	params := new(deleteExpertProjectParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteExpertProjectResponse{Message: "Invalid request params"})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteExpertProjectResponse{Message: "Invalid request params"})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, deleteExpertProjectResponse{Message: "Unauthorized"})
	}
	if !middleware.IsAdmin(user) {
		return c.JSON(http.StatusForbidden, deleteExpertProjectResponse{Message: "Only admins can delete expert graphs"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteExpertProjectResponse{Message: "Internal server error"})
	}
	defer tx.Rollback(ctx)

	q := pgdb.New(conn)
	qtx := q.WithTx(tx)

	_, err = qtx.GetExpertProjectByProjectID(ctx, params.ID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return c.JSON(http.StatusNotFound, deleteExpertProjectResponse{Message: "Expert project not found"})
		}
		return c.JSON(http.StatusInternalServerError, deleteExpertProjectResponse{Message: "Internal server error"})
	}

	if err := qtx.DeleteProject(ctx, params.ID); err != nil {
		return c.JSON(http.StatusInternalServerError, deleteExpertProjectResponse{Message: "Internal server error"})
	}

	if err := tx.Commit(ctx); err != nil {
		return c.JSON(http.StatusInternalServerError, deleteExpertProjectResponse{Message: "Internal server error"})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	storage.DeleteFolder(ctx, s3Client, fmt.Sprintf("projects/%d", params.ID))

	return c.JSON(http.StatusOK, deleteExpertProjectResponse{Message: "Expert project deleted"})
}
