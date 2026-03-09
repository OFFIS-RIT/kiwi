package routes

import (
	"database/sql"
	"net/http"
	"strings"

	_ "github.com/go-playground/validator"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

// CreateExpertProjectHandler creates an expert graph project from multipart/form-data.
func CreateExpertProjectHandler(c echo.Context) error {
	type createExpertProjectBody struct {
		GroupID     string `form:"group_id"`
		GraphID     string `form:"graph_id"`
		Name        string `form:"name" validate:"required"`
		Description string `form:"description" validate:"omitempty"`
	}

	type createExpertProjectResponse struct {
		Message      string              `json:"message"`
		Project      *pgdb.Graph         `json:"project,omitempty"`
		ProjectFiles *[]pgdb.ProjectFile `json:"project_files,omitempty"`
	}

	data := new(createExpertProjectBody)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, createExpertProjectResponse{Message: "Invalid request body"})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, createExpertProjectResponse{Message: "Invalid request body"})
	}

	data.Name = strings.TrimSpace(data.Name)
	data.Description = strings.TrimSpace(data.Description)
	if data.Name == "" {
		return c.JSON(http.StatusBadRequest, createExpertProjectResponse{Message: "Invalid request body"})
	}
	ownerCount := 0
	if data.GroupID != "" {
		ownerCount++
	}
	if data.GraphID != "" {
		ownerCount++
	}
	if ownerCount > 1 {
		return c.JSON(http.StatusBadRequest, createExpertProjectResponse{Message: "only one of group_id, graph_id may be set"})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, createExpertProjectResponse{Message: "Unauthorized"})
	}
	if !middleware.IsAdmin(user) {
		return c.JSON(http.StatusForbidden, createExpertProjectResponse{Message: "Only admins can create expert graphs"})
	}

	form, err := c.MultipartForm()
	if err != nil {
		return c.JSON(http.StatusBadRequest, createExpertProjectResponse{Message: "Invalid request body"})
	}
	uploads := form.File["files"]

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		logger.Error("Failed to begin transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
	}
	defer tx.Rollback(ctx)

	q := pgdb.New(conn)
	qtx := q.WithTx(tx)

	if data.GroupID != "" {
		_, err = qtx.GetGroup(ctx, data.GroupID)
		if err != nil {
			if err == sql.ErrNoRows {
				return c.JSON(http.StatusNotFound, createExpertProjectResponse{Message: "Group not found"})
			}
			logger.Error("Failed to get group", "err", err)
			return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
		}
	}

	if data.GraphID != "" {
		_, err = qtx.GetProjectByID(ctx, data.GraphID)
		if err != nil {
			if err == sql.ErrNoRows {
				return c.JSON(http.StatusNotFound, createExpertProjectResponse{Message: "Graph not found"})
			}
			logger.Error("Failed to get graph", "err", err)
			return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
		}
	}

	createParams := pgdb.CreateProjectWithOwnerParams{
		ID:          ids.New(),
		Name:        data.Name,
		Description: pgtype.Text{String: data.Description, Valid: data.Description != ""},
		State:       "ready",
		Type:        pgtype.Text{String: "expert", Valid: true},
		Hidden:      true,
	}
	if len(uploads) > 0 {
		createParams.State = "create"
	}
	if data.GroupID != "" {
		createParams.GroupID = pgtype.Text{String: data.GroupID, Valid: true}
	}
	if data.GraphID != "" {
		createParams.GraphID = pgtype.Text{String: data.GraphID, Valid: true}
	}

	project, err := qtx.CreateProjectWithOwner(ctx, createParams)
	if err != nil {
		logger.Error("Failed to create expert graph", "err", err)
		return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
	}

	if err := qtx.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
		ID:            ids.New(),
		ProjectID:     project.ID,
		UpdateType:    "create",
		UpdateMessage: util.ConvertStructToJson(project),
	}); err != nil {
		logger.Error("Failed to add project update", "err", err)
		return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	uploadedFiles, err := uploadProjectFiles(ctx, s3Client, project.ID, uploads)
	if err != nil {
		logger.Error("Failed to upload expert project files", "err", err)
		return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
	}

	projectFiles, err := createProjectFiles(ctx, qtx, project.ID, uploadedFiles)
	if err != nil {
		logger.Error("Failed to create expert project files", "err", err)
		return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
	}

	if _, err := c.(*middleware.AppContext).App.Workflows.EnqueueProcessFiles(ctx, tx, project.ID, projectFiles, "index"); err != nil {
		logger.Error("Failed to enqueue expert project workflows", "err", err)
		return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
	}

	if err := tx.Commit(ctx); err != nil {
		logger.Error("Failed to commit transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, createExpertProjectResponse{Message: "Internal server error"})
	}

	return c.JSON(http.StatusOK, createExpertProjectResponse{
		Message:      "Expert project created successfully",
		Project:      &project,
		ProjectFiles: &projectFiles,
	})
}
