package routes

import (
	"database/sql"
	"fmt"
	"net/http"
	"slices"

	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/jackc/pgx/v5/pgtype"
)

// DeleteFileFromProjectHandler marks files for deletion in a project
func DeleteFileFromProjectHandler(c echo.Context) error {
	type deleteProjectData struct {
		ProjectID string   `param:"id" validate:"required"`
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
		if project.UserID.String != user.UserID {
			return c.JSON(http.StatusForbidden, deleteProjectResponse{Message: "You are not allowed to modify this project"})
		}
	} else if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			ID:     data.ProjectID,
			UserID: pgtype.Text{String: user.UserID, Valid: true},
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, deleteProjectResponse{Message: "You are not allowed to modify this project"})
		}
	}

	targetFiles := make([]pgdb.ProjectFile, 0, len(data.FileKeys))
	projectFiles, err := qtx.GetProjectFiles(ctx, data.ProjectID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{Message: "Internal server error"})
	}
	for _, file := range projectFiles {
		if slices.Contains(data.FileKeys, file.FileKey) {
			targetFiles = append(targetFiles, file)
		}
	}
	if len(targetFiles) == 0 {
		return c.JSON(http.StatusBadRequest, deleteProjectResponse{Message: "No matching files found"})
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

	if _, err := c.(*middleware.AppContext).App.Workflows.EnqueueDeleteFiles(ctx, tx, data.ProjectID, targetFiles); err != nil {
		logger.Error("Failed to enqueue delete workflows", "err", err)
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
		Files:   &projectFiles,
	})
}

// DeleteProjectHandler delete a project and all its content
func DeleteProjectHandler(c echo.Context) error {
	type deleteProjectParams struct {
		ID string `param:"id" validate:"required"`
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
		if project.UserID.String != user.UserID {
			return c.JSON(http.StatusForbidden, deleteProjectResponse{Message: "You are not allowed to modify this project"})
		}
	} else if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			ID:     params.ID,
			UserID: pgtype.Text{String: user.UserID, Valid: true},
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, deleteProjectResponse{Message: "You are not allowed to modify this project"})
		}
	}

	if _, err := qtx.CancelWorkflowRunsByProject(ctx, params.ID); err != nil {
		return c.JSON(http.StatusInternalServerError, deleteProjectResponse{
			Message: "Internal server error",
		})
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
	storage.DeleteFolder(ctx, s3Client, fmt.Sprintf("projects/%s", params.ID))

	return c.JSON(http.StatusOK, deleteProjectResponse{
		Message: "Project deleted",
	})
}
