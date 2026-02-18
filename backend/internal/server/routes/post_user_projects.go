package routes

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	_ "github.com/go-playground/validator"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/labstack/echo/v4"
	gonanoid "github.com/matoous/go-nanoid/v2"

	"github.com/OFFIS-RIT/kiwi/backend/internal/queue"
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
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

	project, err := qtx.CreateProjectWithOwner(ctx, pgdb.CreateProjectWithOwnerParams{
		UserID:      sql.NullInt64{Int64: user.UserID, Valid: true},
		Name:        data.Name,
		Description: pgtype.Text{},
		State:       "create",
		Type:        projectType,
		Hidden:      hidden,
	})
	if err != nil {
		logger.Error("Failed to create user project", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	if err := qtx.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
		ProjectID:     project.ID,
		UpdateType:    "create",
		UpdateMessage: json.RawMessage(util.ConvertStructToJson(project)),
	}); err != nil {
		logger.Error("Failed to add project update", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	keys := make(map[string]string, 0)
	for _, file := range uploads {
		src, err := file.Open()
		if err != nil {
			return c.JSON(http.StatusBadRequest, createUserProjectResponse{Message: "Invalid request body"})
		}
		defer src.Close()

		fID, err := gonanoid.New()
		if err != nil {
			return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
		}

		key, err := storage.PutFile(ctx, s3Client, fmt.Sprintf("projects/%d/files", project.ID), file.Filename, fID, src)
		if err != nil {
			logger.Error("Failed to upload file", "err", err)
			return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
		}
		keys[key] = file.Filename
	}

	projectFiles := make([]pgdb.ProjectFile, 0)
	for key, name := range keys {
		projectFile, err := qtx.AddFileToProject(ctx, pgdb.AddFileToProjectParams{
			ProjectID: project.ID,
			Name:      name,
			FileKey:   key,
		})
		if err != nil {
			logger.Error("Failed to add file to project", "err", err)
			return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
		}

		if err := qtx.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
			ProjectID:     project.ID,
			UpdateType:    "add_file",
			UpdateMessage: json.RawMessage(util.ConvertStructToJson(projectFile)),
		}); err != nil {
			logger.Error("Failed to add project update", "err", err)
			return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
		}

		projectFiles = append(projectFiles, projectFile)
	}

	if err := tx.Commit(ctx); err != nil {
		logger.Error("Failed to commit transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, createUserProjectResponse{Message: "Internal server error"})
	}

	batchSize := int(util.GetEnvNumeric("WORKER_BATCH_SIZE", 10))
	correlationID, _ := gonanoid.New()
	totalBatches := (len(projectFiles) + batchSize - 1) / batchSize

	for batchID := range totalBatches {
		startIdx := batchID * batchSize
		endIdx := min(startIdx+batchSize, len(projectFiles))
		batchFiles := projectFiles[startIdx:endIdx]

		fileIDs := make([]int64, len(batchFiles))
		for i, f := range batchFiles {
			fileIDs[i] = f.ID
		}

		_, _ = q.CreateBatchStatus(ctx, pgdb.CreateBatchStatusParams{
			ProjectID:     project.ID,
			CorrelationID: correlationID,
			BatchID:       int32(batchID),
			TotalBatches:  int32(totalBatches),
			FilesCount:    int32(len(batchFiles)),
			FileIds:       fileIDs,
			Operation:     "index",
		})
	}

	ch := c.(*middleware.AppContext).App.Queue
	for batchID := range totalBatches {
		startIdx := batchID * batchSize
		endIdx := min(startIdx+batchSize, len(projectFiles))
		batchFiles := projectFiles[startIdx:endIdx]

		queueData := queue.QueueProjectFileMsg{
			Message:       "User project created successfully",
			ProjectID:     project.ID,
			CorrelationID: correlationID,
			BatchID:       batchID,
			TotalBatches:  totalBatches,
			ProjectFiles:  &batchFiles,
			Operation:     "index",
		}

		if err := queue.PublishFIFO(ch, "preprocess_queue", []byte(util.ConvertStructToJson(queueData))); err != nil {
			logger.Error("Failed to publish batch to preprocess_queue", "batch_id", batchID, "err", err)
		}
	}

	return c.JSON(http.StatusOK, createUserProjectResponse{
		Message:      "User project created successfully",
		Project:      &project,
		ProjectFiles: &projectFiles,
	})
}
