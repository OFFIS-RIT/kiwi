package routes

import (
	"database/sql"
	"encoding/json"
	"fmt"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphstorage "github.com/OFFIS-RIT/kiwi/backend/pkg/store/pgx"

	"net/http"
	"regexp"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/internal/queue"
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"

	"slices"

	bqc "github.com/OFFIS-RIT/kiwi/backend/pkg/query/pgx"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"
	gonanoid "github.com/matoous/go-nanoid/v2"
)

// CreateProjectHandler creates a new project from multipart/form-data
func CreateProjectHandler(c echo.Context) error {
	type createProjectBody struct {
		GroupID int64  `form:"group_id" validate:"required,numeric"`
		Name    string `form:"name" validate:"required"`
	}

	type createProjectResponse struct {
		Message      string              `json:"message"`
		Project      *pgdb.Project       `json:"project,omitempty"`
		ProjectFiles *[]pgdb.ProjectFile `json:"project_files,omitempty"`
	}

	data := new(createProjectBody)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, createProjectResponse{
			Message: "Invalid request body",
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, createProjectResponse{
			Message: "Invalid request body",
		})
	}

	form, err := c.MultipartForm()
	if err != nil {
		return c.JSON(http.StatusBadRequest, createProjectResponse{
			Message: "Invalid request body",
		})
	}
	uploads := form.File["files"]

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, createProjectResponse{
			Message: "Unauthorized",
		})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		logger.Error("Failed to begin transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{
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
			return c.JSON(http.StatusForbidden, createProjectResponse{
				Message: "You are not a member of this group",
			})
		}
	}

	_ , err = qtx.GetGroup(ctx, data.GroupID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, createProjectResponse{
				Message: "Group not found",
			})
		} else {
			logger.Error("Failed to get group", "err", err)
			return c.JSON(http.StatusInternalServerError, createProjectResponse{
				Message: "Internal server error",
			})
		}
	}

	project, err := qtx.CreateProject(ctx, pgdb.CreateProjectParams{
		GroupID: data.GroupID,
		Name:    data.Name,
		State:   "create",
	})
	if err != nil {
		logger.Error("Failed to create project", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{
			Message: "Internal server error",
		})
	}
	err = qtx.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
		ProjectID:     project.ID,
		UpdateType:    "create",
		UpdateMessage: json.RawMessage(util.ConvertStructToJson(project)),
	})
	if err != nil {
		logger.Error("Failed to add project update", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{
			Message: "Internal server error",
		})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	keys := make(map[string]string, 0)
	for _, file := range uploads {
		src, err := file.Open()
		if err != nil {
			return c.JSON(http.StatusBadRequest, createProjectResponse{
				Message: "Invalid request body",
			})
		}
		defer src.Close()

		fId, err := gonanoid.New()
		if err != nil {
			return c.JSON(http.StatusInternalServerError, createProjectResponse{
				Message: "Internal server error",
			})
		}
		key, err := storage.PutFile(
			ctx,
			s3Client,
			fmt.Sprintf("projects/%d/files", project.ID),
			file.Filename,
			fId,
			src,
		)
		if err != nil {
			logger.Error("Failed to upload file", "err", err)
			return c.JSON(http.StatusInternalServerError, createProjectResponse{
				Message: "Internal server error",
			})
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
			return c.JSON(http.StatusInternalServerError, createProjectResponse{
				Message: "Internal server error",
			})
		}
		err = qtx.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
			ProjectID:     project.ID,
			UpdateType:    "add_file",
			UpdateMessage: json.RawMessage(util.ConvertStructToJson(projectFile)),
		})
		if err != nil {
			logger.Error("Failed to add project update", "err", err)
			return c.JSON(http.StatusInternalServerError, createProjectResponse{
				Message: "Internal server error",
			})
		}
		projectFiles = append(projectFiles, projectFile)
	}

	err = tx.Commit(ctx)
	if err != nil {
		logger.Error("Failed to commit transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{
			Message: "Internal server error",
		})
	}

	resp := createProjectResponse{
		Message:      "Project created successfully",
		Project:      &project,
		ProjectFiles: &projectFiles,
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

		logger.Debug("[Server] Creating batch status", "project_id", project.ID, "correlation_id", correlationID, "batch_id", batchID, "total_batches", totalBatches, "files_count", len(batchFiles))
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
			Message:       "Project created successfully",
			ProjectID:     project.ID,
			CorrelationID: correlationID,
			BatchID:       batchID,
			TotalBatches:  totalBatches,
			ProjectFiles:  &batchFiles,
			Operation:     "index",
		}

		err = queue.PublishFIFO(ch, "preprocess_queue", []byte(util.ConvertStructToJson(queueData)))
		if err != nil {
			logger.Error("Failed to publish batch to preprocess_queue", "batch_id", batchID, "err", err)
		}
	}

	return c.JSON(
		http.StatusOK,
		resp,
	)
}

// AddFilesToProjectHandler adds files to an existing project (multipart/form-data)
func AddFilesToProjectHandler(c echo.Context) error {
	type addFilesParams struct {
		ProjectID int64 `param:"id" validate:"required,numeric"`
	}

	type addFilesResponse struct {
		Message      string              `json:"message"`
		ProjectID    int64               `json:"project_id"`
		ProjectFiles []*pgdb.ProjectFile `json:"project_files,omitempty"`
	}

	params := new(addFilesParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, addFilesResponse{
			Message: "Invalid request body",
		})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, addFilesResponse{
			Message: "Invalid request body",
		})
	}

	form, err := c.MultipartForm()
	if err != nil {
		return c.JSON(http.StatusBadRequest, addFilesResponse{
			Message: "Invalid request body",
		})
	}
	uploads := form.File["files"]
	if len(uploads) == 0 {
		return c.JSON(http.StatusBadRequest, addFilesResponse{
			Message: "No files provided",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
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
			return c.JSON(http.StatusForbidden, addFilesResponse{
				Message: "You are not a member of this project",
			})
		}
	}

	_, err = q.GetGroupByProjectId(ctx, params.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, addFilesResponse{
				Message: "Project or Group not found",
			})
		} else {
			logger.Error("Failed to get group", "err", err)
			return c.JSON(http.StatusInternalServerError, addFilesResponse{
				Message: "Internal server error",
			})
		}
	}

	s3Client := c.(*middleware.AppContext).App.S3

	keys := make(map[string]string, 0)
	for _, file := range uploads {
		src, err := file.Open()
		if err != nil {
			return c.JSON(http.StatusBadRequest, addFilesResponse{
				Message: "Could not open file",
			})
		}
		defer src.Close()

		fId, err := gonanoid.New()
		if err != nil {
			return c.JSON(http.StatusInternalServerError, addFilesResponse{
				Message: "Internal server error",
			})
		}
		key, err := storage.PutFile(
			ctx,
			s3Client,
			fmt.Sprintf("projects/%d/files", params.ProjectID),
			file.Filename,
			fId,
			src,
		)
		if err != nil {
			logger.Error("Failed to upload file", "err", err)
			return c.JSON(http.StatusInternalServerError, addFilesResponse{
				Message: "Internal server error",
			})
		}
		keys[key] = file.Filename
	}


	projectFiles := make([]*pgdb.ProjectFile, 0)
	for key, name := range keys {
		projectFile, err := q.AddFileToProject(ctx, pgdb.AddFileToProjectParams{
			ProjectID: params.ProjectID,
			Name:      name,
			FileKey:   key,
		})
		if err != nil {
			return c.JSON(http.StatusInternalServerError, addFilesResponse{
				Message: "Failed to add file to project",
			})
		}
		err = q.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
			ProjectID:     params.ProjectID,
			UpdateType:    "add_file",
			UpdateMessage: json.RawMessage(util.ConvertStructToJson(projectFile)),
		})
		if err != nil {
			return c.JSON(http.StatusInternalServerError, addFilesResponse{
				Message: "Failed to add file to project",
			})
		}
		projectFiles = append(projectFiles, &projectFile)
	}

	resp := addFilesResponse{
		Message:      "File added successfully",
		ProjectID:    params.ProjectID,
		ProjectFiles: projectFiles,
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
			ProjectID:     params.ProjectID,
			CorrelationID: correlationID,
			BatchID:       int32(batchID),
			TotalBatches:  int32(totalBatches),
			FilesCount:    int32(len(batchFiles)),
			FileIds:       fileIDs,
			Operation:     "update",
		})
	}

	ch := c.(*middleware.AppContext).App.Queue
	for batchID := range totalBatches {
		startIdx := batchID * batchSize
		endIdx := min(startIdx+batchSize, len(projectFiles))
		batchFilesPtrs := projectFiles[startIdx:endIdx]

		batchFiles := make([]pgdb.ProjectFile, len(batchFilesPtrs))
		for i, pf := range batchFilesPtrs {
			batchFiles[i] = *pf
		}

		queueData := queue.QueueProjectFileMsg{
			Message:       "File added successfully",
			ProjectID:     params.ProjectID,
			CorrelationID: correlationID,
			BatchID:       batchID,
			TotalBatches:  totalBatches,
			ProjectFiles:  &batchFiles,
			Operation:     "update",
		}

		err = queue.PublishFIFO(ch, "preprocess_queue", []byte(util.ConvertStructToJson(queueData)))
		if err != nil {
			logger.Error("Failed to publish batch to preprocess_queue", "batch_id", batchID, "err", err)
		}
	}

	return c.JSON(
		http.StatusOK,
		resp,
	)
}

// QueryProjectHandler handles project queries
func QueryProjectHandler(c echo.Context) error {
	type queryProjectRequest struct {
		ProjectID int64            `param:"id" validate:"required,numeric"`
		Messages  []ai.ChatMessage `json:"messages" validate:"required"`
		Mode      string           `json:"mode"`
		Model     string           `json:"model"`
		Think     bool             `json:"think"`
	}

	type responseData struct {
		ID   string  `json:"id"`
		Name string  `json:"name"`
		Key  string  `json:"key"`
		Text *string `json:"text,omitempty"`
	}

	type queryProjectResponse struct {
		Message string           `json:"message"`
		Data    []responseData   `json:"data,omitempty"`
		Metrics *ai.ModelMetrics `json:"metrics,omitempty"`
	}

	data := new(queryProjectRequest)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, queryProjectResponse{
			Message: "Invalid request body",
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, queryProjectResponse{
			Message: "Invalid request body",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, queryProjectResponse{
			Message: "Unauthorized",
		})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			UserID: user.UserID,
			ID:     data.ProjectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, queryProjectResponse{
				Message: "Unauthorized",
			})
		}
	}

	_, err := q.GetGroupByProjectId(ctx, data.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, queryProjectResponse{
				Message: "Project or Group not found",
			})
		} else {
			logger.Error("Failed to get group", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{
				Message: "Internal server error",
			})
		}
	}

	msgs := make([]string, 1)
	msgs[0] = data.Messages[len(data.Messages)-1].Message

	aiClient := c.(*middleware.AppContext).App.AiClient
	storageClient, err := graphstorage.NewGraphDBStorageWithConnection(ctx, conn, aiClient, msgs)

	prompts, err := q.GetProjectSystemPrompts(ctx, data.ProjectID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Internal server error",
		})
	}
	systemPrompts := make([]string, 0, len(prompts))
	for _, prompt := range prompts {
		systemPrompts = append(systemPrompts, prompt.Prompt)
	}

	opts := []bqc.QueryOption{}
	if len(systemPrompts) > 0 {
		opts = append(opts, bqc.WithSystemPrompts(systemPrompts...))
	}
	if data.Model != "" {
		opts = append(opts, bqc.WithModel(data.Model))
	}
	if data.Think {
		opts = append(opts, bqc.WithThinking("high"))
	}

	queryClient := bqc.NewGraphQueryClient(aiClient, storageClient, fmt.Sprintf("%d", data.ProjectID), opts)

	var answer string
	switch data.Mode {
	case "normal":
		answer, err = queryClient.QueryLocal(ctx, data.Messages)
	case "agentic":
		toolList := graphstorage.GetToolList(conn, aiClient, data.ProjectID)
		answer, err = queryClient.QueryAgentic(ctx, data.Messages, toolList)
	default:
		answer, err = queryClient.QueryLocal(ctx, data.Messages)
	}
	if err != nil || answer == "" {
		logger.Error("[Query] graph error", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Es ist ein interner Fehler aufgetreten.",
		})
	}

	answer = util.NormalizeIDs(answer)
	re := regexp.MustCompile(`\[\[([^][]+)\]\]`)
	matches := re.FindAllStringSubmatch(answer, -1)
	findings := make([]string, 0)
	for _, match := range matches {
		id := match[1]
		found := slices.Contains(findings, id)
		if !found {
			findings = append(findings, id)
		}
	}
	files, err := q.GetFilesFromTextUnitIDs(ctx, findings)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Internal server error",
		})
	}
	fileData := make([]responseData, 0)
	for _, file := range files {
		fileData = append(fileData, responseData{
			ID:   file.PublicID,
			Key:  file.FileKey,
			Name: file.Name,
		})
	}

	metrics := aiClient.GetMetrics()
	return c.JSON(http.StatusOK, queryProjectResponse{
		Message: answer,
		Data:    fileData,
		Metrics: &metrics,
	})
}

// QueryProjectStreamHandler handles streaming project queries
func QueryProjectStreamHandler(c echo.Context) error {
	type queryProjectRequest struct {
		ProjectID int64            `param:"id" validate:"required,numeric"`
		Messages  []ai.ChatMessage `json:"messages" validate:"required"`
		Mode      string           `json:"mode"`
		Model     string           `json:"model"`
		Think     bool             `json:"think"`
	}

	type responseData struct {
		ID   string  `json:"id"`
		Name string  `json:"name"`
		Key  string  `json:"key"`
		Text *string `json:"text,omitempty"`
	}

	type streamResponse struct {
		Step      string           `json:"step,omitempty"`
		Message   string           `json:"message"`
		Reasoning string           `json:"reasoning,omitempty"`
		Data      []responseData   `json:"data"`
		Metrics   *ai.ModelMetrics `json:"metrics,omitempty"`
	}

	data := new(queryProjectRequest)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, streamResponse{
			Message: "Invalid request body",
			Data:    []responseData{},
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, streamResponse{
			Message: "Invalid request body",
			Data:    []responseData{},
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, streamResponse{
			Message: "Unauthorized",
			Data:    []responseData{},
		})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			UserID: user.UserID,
			ID:     data.ProjectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, streamResponse{
				Message: "Unauthorized",
				Data:    []responseData{},
			})
		}
	}

	_, err := q.GetGroupByProjectId(ctx, data.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, streamResponse{
				Message: "Project or Group not found",
				Data:    []responseData{},
			})
		} else {
			logger.Error("Failed to get group", "err", err)
			return c.JSON(http.StatusInternalServerError, streamResponse{
				Message: "Internal server error",
				Data:    []responseData{},
			})
		}
	}

	msgs := make([]string, 1)
	msgs[0] = data.Messages[len(data.Messages)-1].Message

	aiClient := c.(*middleware.AppContext).App.AiClient
	storageClient, err := graphstorage.NewGraphDBStorageWithConnection(ctx, conn, aiClient, msgs)

	prompts, err := q.GetProjectSystemPrompts(ctx, data.ProjectID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, streamResponse{
			Message: "Internal server error",
		})
	}
	systemPrompts := make([]string, 0, len(prompts))
	for _, prompt := range prompts {
		systemPrompts = append(systemPrompts, prompt.Prompt)
	}

	opts := []bqc.QueryOption{}
	if len(systemPrompts) > 0 {
		opts = append(opts, bqc.WithSystemPrompts(systemPrompts...))
	}
	if data.Model != "" {
		opts = append(opts, bqc.WithModel(data.Model))
	}
	if data.Think {
		opts = append(opts, bqc.WithThinking("high"))
	}

	c.Response().Header().Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	c.Response().WriteHeader(http.StatusOK)

	queryClient := bqc.NewGraphQueryClient(aiClient, storageClient, fmt.Sprintf("%d", data.ProjectID), opts)

	var contentChan <-chan ai.StreamEvent
	switch data.Mode {
	case "normal":
		contentChan, err = queryClient.QueryStreamLocal(ctx, data.Messages)
	case "agentic":
		toolList := graphstorage.GetToolList(conn, aiClient, data.ProjectID)
		contentChan, err = queryClient.QueryStreamAgentic(ctx, data.Messages, toolList)
	default:
		contentChan, err = queryClient.QueryStreamLocal(ctx, data.Messages)
	}
	if err != nil {
		enc := json.NewEncoder(c.Response())
		enc.Encode(streamResponse{
			Message: "Es ist ein interner Fehler aufgetreten.",
			Data:    []responseData{},
		})
		c.Response().Flush()
		return nil
	}

	enc := json.NewEncoder(c.Response())
	re := regexp.MustCompile(`\[\[([^][]+)\]\]`)
	foundIds := make(map[string]bool)
	var messageBuffer strings.Builder
	var reasoningBuffer strings.Builder
	var allFoundData []responseData

	for event := range contentChan {
		if event.Type == "step" {
			resp := streamResponse{
				Step:    event.Step,
				Message: messageBuffer.String(),
				Data:    allFoundData,
			}
			if event.Step == "thinking" && event.Reasoning != "" {
				reasoningBuffer.WriteString(event.Reasoning)
			}
			if reasoningBuffer.Len() > 0 {
				resp.Reasoning = reasoningBuffer.String()
			}
			if err := enc.Encode(resp); err != nil {
				return err
			}
			c.Response().Flush()
			continue
		}

		messageBuffer.WriteString(event.Content)
		currentMessage := messageBuffer.String()

		// Check for new data references in the current buffer
		currentMessage = util.NormalizeIDs(currentMessage)
		matches := re.FindAllStringSubmatch(currentMessage, -1)
		newIds := make([]string, 0)

		for _, match := range matches {
			id := match[1]
			if !foundIds[id] {
				foundIds[id] = true
				newIds = append(newIds, id)
			}
		}

		if len(newIds) > 0 {
			files, err := q.GetFilesFromTextUnitIDs(ctx, newIds)
			if err != nil {
				logger.Error("Error getting files for stream response", "err", err)
			} else {
				for _, file := range files {
					allFoundData = append(allFoundData, responseData{
						ID:   file.PublicID,
						Key:  file.FileKey,
						Name: file.Name,
					})
				}
			}
		}

		resp := streamResponse{
			Message: currentMessage,
			Data:    allFoundData,
		}
		if reasoningBuffer.Len() > 0 {
			resp.Reasoning = reasoningBuffer.String()
		}
		if err := enc.Encode(resp); err != nil {
			return err
		}
		c.Response().Flush()
	}

	metrics := aiClient.GetMetrics()
	finalResp := streamResponse{
		Message: messageBuffer.String(),
		Data:    allFoundData,
		Metrics: &metrics,
	}
	if reasoningBuffer.Len() > 0 {
		finalResp.Reasoning = reasoningBuffer.String()
	}
	return c.JSON(http.StatusOK, finalResp)
}
