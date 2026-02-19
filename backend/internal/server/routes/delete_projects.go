package routes

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/internal/queue"
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

// DeleteFileFromProjectHandler marks files for deletion in a project
func DeleteFileFromProjectHandler(c echo.Context) error {
	type deleteProjectData struct {
		ProjectID int64    `param:"id" validate:"required,numeric"`
		FileKeys  []string `json:"file_keys" validate:"required"`
	}

	type deleteProjectResponse struct {
		Message string              `json:"message"`
		Files   *[]pgdb.ProjectFile `json:"files,omitempty"`
	}

	data := new(deleteProjectData)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, deleteProjectResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, deleteProjectResponse{
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
		return c.JSON(http.StatusBadRequest, deleteProjectResponse{
			Message: "Internal server error",
		})
	}
	defer tx.Rollback(ctx)
	q := pgdb.New(conn)
	qtx := q.WithTx(tx)

	project, err := qtx.GetProjectByID(ctx, data.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, deleteProjectResponse{Message: "Project not found"})
		}
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{Message: "Internal server error"})
	}

	if project.UserID.Valid {
		if project.UserID.Int64 != user.UserID {
			return c.JSON(http.StatusForbidden, deleteProjectResponse{Message: "You are not allowed to modify this project"})
		}
	} else if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			ID:     data.ProjectID,
			UserID: user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, deleteProjectResponse{Message: "You are not allowed to modify this project"})
		}
	}

	for _, fileKey := range data.FileKeys {
		err = qtx.MarkProjectFileAsDeleted(ctx, pgdb.MarkProjectFileAsDeletedParams{
			ProjectID: data.ProjectID,
			FileKey:   fileKey,
		})
		if err != nil {
			return c.JSON(http.StatusInternalServerError, deleteProjectResponse{
				Message: "Internal server error",
			})
		}
	}

	dbFiles, err := qtx.GetProjectFiles(ctx, data.ProjectID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{
			Message: "Internal server error",
		})
	}

	type deleteStruct struct {
		ProjectID int64 `json:"project_id"`
	}

	ch := c.(*middleware.AppContext).App.Queue
	err = queue.PublishFIFO(ch, "delete_queue", []byte(util.ConvertStructToJson(deleteStruct{
		ProjectID: data.ProjectID,
	})))
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{Message: "Internal server error"})
	}

	err = tx.Commit(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{
			Message: "Internal server error",
		})
	}

	return c.JSON(http.StatusOK, deleteProjectResponse{
		Message: "Files marked for deletion",
		Files:   &dbFiles,
	})
}

// DeleteProjectHandler delete a project and all its content
func DeleteProjectHandler(c echo.Context) error {
	type deleteProjectParams struct {
		ID int64 `param:"id" validate:"required,numeric"`
	}

	type deleteProjectResponse struct {
		Message string `json:"message"`
	}

	params := new(deleteProjectParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteProjectResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, deleteProjectResponse{
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
		return c.JSON(http.StatusBadRequest, deleteProjectResponse{
			Message: "Internal server error",
		})
	}
	defer tx.Rollback(ctx)
	q := pgdb.New(conn)
	qtx := q.WithTx(tx)

	project, err := qtx.GetProjectByID(ctx, params.ID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, deleteProjectResponse{Message: "Project not found"})
		}
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{Message: "Internal server error"})
	}

	if project.UserID.Valid {
		if project.UserID.Int64 != user.UserID {
			return c.JSON(http.StatusForbidden, deleteProjectResponse{Message: "You are not allowed to modify this project"})
		}
	} else if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			ID:     params.ID,
			UserID: user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, deleteProjectResponse{Message: "You are not allowed to modify this project"})
		}
	}

	err = qtx.DeleteProject(ctx, params.ID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{
			Message: "Internal server error",
		})
	}

	err = tx.Commit(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{
			Message: "Internal server error",
		})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	storage.DeleteFolder(ctx, s3Client, fmt.Sprintf("projects/%d", params.ID))

	return c.JSON(http.StatusOK, deleteProjectResponse{
		Message: "Project deleted",
	})
}
