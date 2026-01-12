package routes

import (
	"encoding/json"
	"fmt"
	"kiwi/internal/db"
	"kiwi/pkg/logger"
	graphstorage "kiwi/pkg/store/base"

	"kiwi/internal/queue"
	"kiwi/internal/server/middleware"
	"kiwi/internal/storage"
	"kiwi/internal/util"
	"net/http"
	"regexp"
	"strings"

	"slices"

	bqc "kiwi/pkg/query/base"

	"kiwi/pkg/ai"

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
		Message      string            `json:"message"`
		Project      *db.Project       `json:"project,omitempty"`
		ProjectFiles *[]db.ProjectFile `json:"project_files,omitempty"`
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
	q := db.New(conn)
	qtx := q.WithTx(tx)

	if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInGroup(ctx, db.IsUserInGroupParams{
			GroupID: data.GroupID,
			UserID:  user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, createProjectResponse{
				Message: "You are not a member of this group",
			})
		}
	}

	project, err := qtx.CreateProject(ctx, db.CreateProjectParams{
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
	err = qtx.AddProjectUpdate(ctx, db.AddProjectUpdateParams{
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

	projectFiles := make([]db.ProjectFile, 0)
	for key, name := range keys {
		projectFile, err := qtx.AddFileToProject(ctx, db.AddFileToProjectParams{
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
		err = qtx.AddProjectUpdate(ctx, db.AddProjectUpdateParams{
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

	type preprocessQueue struct {
		Message      string            `json:"message"`
		ProjectID    int64             `json:"project_id,omitempty"`
		ProjectFiles *[]db.ProjectFile `json:"project_files,omitempty"`
		QueueType    string            `json:"queue_type"`
	}

	queueData := preprocessQueue{
		Message:      "Project created successfully",
		ProjectID:    project.ID,
		ProjectFiles: &projectFiles,
		QueueType:    "index",
	}

	ch := c.(*middleware.AppContext).App.Queue
	err = queue.PublishFIFO(ch, "preprocess_queue", []byte(util.ConvertStructToJson(queueData)))
	if err != nil {
		logger.Error("Failed to publish to preprocess_queue", "err", err)
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
		Message      string            `json:"message"`
		ProjectID    int64             `json:"project_id"`
		ProjectFiles []*db.ProjectFile `json:"project_files,omitempty"`
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

	conn := c.(*middleware.AppContext).App.DBConn
	q := db.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, db.IsUserInProjectParams{
			ID:     params.ProjectID,
			UserID: user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, addFilesResponse{
				Message: "You are not a member of this project",
			})
		}
	}

	projectFiles := make([]*db.ProjectFile, 0)
	for key, name := range keys {
		projectFile, err := q.AddFileToProject(ctx, db.AddFileToProjectParams{
			ProjectID: params.ProjectID,
			Name:      name,
			FileKey:   key,
		})
		if err != nil {
			return c.JSON(http.StatusInternalServerError, addFilesResponse{
				Message: "Failed to add file to project",
			})
		}
		err = q.AddProjectUpdate(ctx, db.AddProjectUpdateParams{
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

	type preprocessQueue struct {
		Message      string            `json:"message"`
		ProjectID    int64             `json:"project_id,omitempty"`
		ProjectFiles []*db.ProjectFile `json:"project_files,omitempty"`
		QueueType    string            `json:"queue_type"`
	}

	queueData := preprocessQueue{
		Message:      "File added successfully",
		ProjectID:    params.ProjectID,
		ProjectFiles: projectFiles,
		QueueType:    "update",
	}

	ch := c.(*middleware.AppContext).App.Queue
	err = queue.PublishFIFO(ch, "preprocess_queue", []byte(util.ConvertStructToJson(queueData)))
	if err != nil {
		logger.Error("Failed to publish to preprocess_queue", "err", err)
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
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := db.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, db.IsUserInProjectParams{
			UserID: user.UserID,
			ID:     data.ProjectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, map[string]string{"error": "Unauthorized"})
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
		opts = append(opts, bqc.WithThinking("medium"))
	}

	queryClient := bqc.NewGraphQueryClient(aiClient, storageClient, fmt.Sprintf("%d", data.ProjectID), opts)

	var answer string
	switch data.Mode {
	case "fast":
		answer, err = queryClient.QueryGlobal(ctx, data.Messages)
	case "normal":
		answer, err = queryClient.QueryLocal(ctx, data.Messages)
	case "detailed":
		toolList := graphstorage.GetToolList(conn, aiClient, data.ProjectID)
		answer, err = queryClient.QueryTool(ctx, data.Messages, toolList)
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
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := db.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, db.IsUserInProjectParams{
			UserID: user.UserID,
			ID:     data.ProjectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, map[string]string{"error": "Unauthorized"})
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
		opts = append(opts, bqc.WithThinking("medium"))
	}

	c.Response().Header().Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	c.Response().WriteHeader(http.StatusOK)

	queryClient := bqc.NewGraphQueryClient(aiClient, storageClient, fmt.Sprintf("%d", data.ProjectID), opts)

	var contentChan <-chan ai.StreamEvent
	switch data.Mode {
	case "fast":
		contentChan, err = queryClient.QueryStreamGlobal(ctx, data.Messages)
	case "normal":
		contentChan, err = queryClient.QueryStreamLocal(ctx, data.Messages)
	case "detailed":
		toolList := graphstorage.GetToolList(conn, aiClient, data.ProjectID)
		contentChan, err = queryClient.QueryStreamTool(ctx, data.Messages, toolList)
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
