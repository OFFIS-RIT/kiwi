package routes

import (
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

// CreateUserProjectHandler creates a user-owned graph from multipart/form-data.
func CreateUserProjectHandler(c echo.Context) error {
	type createUserProjectBody struct {
		Name string `form:"name" validate:"required"`
		Type string `form:"type" validate:"omitempty"`
	}

	type createUserProjectResponse struct {
		Message      string              `json:"message"`
		Project      *pgdb.Graph         `json:"project,omitempty"`
		ProjectFiles *[]pgdb.ProjectFile `json:"project_files,omitempty"`
	}

	data := new(createUserProjectBody)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, createUserProjectResponse{Message: "Invalid request body"})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, createUserProjectResponse{Message: "Invalid request body"})
	}

	data.Name = strings.TrimSpace(data.Name)
	if data.Name == "" {
		return c.JSON(http.StatusBadRequest, createUserProjectResponse{Message: "Invalid request body"})
	}
	data.Type = strings.ToLower(strings.TrimSpace(data.Type))
	if data.Type != "" && data.Type != "expert" {
		return c.JSON(http.StatusBadRequest, createUserProjectResponse{Message: "type must be empty or expert"})
	}

	projectType := pgtype.Text{}
	hidden := false
	if data.Type == "expert" {
		projectType = pgtype.Text{String: "expert", Valid: true}
		hidden = true
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, createUserProjectResponse{Message: "Unauthorized"})
	}

	form, err := c.MultipartForm()
	if err != nil {
		return c.JSON(http.StatusBadRequest, createUserProjectResponse{Message: "Invalid request body"})
	}
	uploads := form.File["files"]

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		logger.Error("Failed to begin transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}
	defer tx.Rollback(ctx)

	q := pgdb.New(conn)
	qtx := q.WithTx(tx)
	state := "create"
	if len(uploads) == 0 {
		state = "ready"
	}

	project, err := qtx.CreateProjectWithOwner(ctx, pgdb.CreateProjectWithOwnerParams{
		ID:          ids.New(),
		UserID:      pgtype.Text{String: user.UserID, Valid: true},
		Name:        data.Name,
		Description: pgtype.Text{},
		State:       state,
		Type:        projectType,
		Hidden:      hidden,
	})
	if err != nil {
		logger.Error("Failed to create user project", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	if err := qtx.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
		ID:            ids.New(),
		ProjectID:     project.ID,
		UpdateType:    "create",
		UpdateMessage: util.ConvertStructToJson(project),
	}); err != nil {
		logger.Error("Failed to add project update", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	uploadedFiles, err := uploadProjectFiles(ctx, s3Client, project.ID, uploads)
	if err != nil {
		logger.Error("Failed to upload project files", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	projectFiles, err := createProjectFiles(ctx, qtx, project.ID, uploadedFiles)
	if err != nil {
		logger.Error("Failed to create project files", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	if _, err := c.(*middleware.AppContext).App.Workflows.EnqueueProcessFiles(ctx, tx, project.ID, projectFiles, "index"); err != nil {
		logger.Error("Failed to enqueue user project workflows", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	if err := tx.Commit(ctx); err != nil {
		logger.Error("Failed to commit transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	return c.JSON(http.StatusOK, createUserProjectResponse{
		Message:      "User project created successfully",
		Project:      &project,
		ProjectFiles: &projectFiles,
	})
}
