package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"
	gonanoid "github.com/matoous/go-nanoid/v2"

	"github.com/OFFIS-RIT/kiwi/backend/internal/queue"
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphquery "github.com/OFFIS-RIT/kiwi/backend/pkg/query"
	bqc "github.com/OFFIS-RIT/kiwi/backend/pkg/query/pgx"
	graphstorage "github.com/OFFIS-RIT/kiwi/backend/pkg/store/pgx"
)

const defaultPendingToolResult = "No answer"

type clientToolCallResponse struct {
	ToolCallID    string `json:"tool_call_id"`
	ToolName      string `json:"tool_name"`
	ToolArguments string `json:"tool_arguments"`
}

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

	_, err = qtx.GetGroup(ctx, data.GroupID)
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
		ProjectID      int64  `param:"id" validate:"required,numeric"`
		Prompt         string `json:"prompt" validate:"required"`
		ConversationID string `json:"conversation_id"`
		Mode           string `json:"mode"`
		Model          string `json:"model"`
		Think          bool   `json:"think"`
		ToolID         string `json:"tool_id,omitempty"`
	}

	type responseData struct {
		ID   string  `json:"id"`
		Name string  `json:"name"`
		Key  string  `json:"key"`
		Text *string `json:"text,omitempty"`
	}

	type queryProjectResponse struct {
		ConversationID      string                  `json:"conversation_id"`
		Message             string                  `json:"message"`
		Data                []responseData          `json:"data"`
		ClientToolCall      *clientToolCallResponse `json:"client_tool_call,omitempty"`
		Reasoning           string                  `json:"reasoning,omitempty"`
		ConsideredFileCount int                     `json:"considered_file_count"`
		UsedFileCount       int                     `json:"used_file_count"`
	}

	data := new(queryProjectRequest)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, queryProjectResponse{
			Message: "Invalid request body",
			Data:    []responseData{},
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, queryProjectResponse{
			Message: "Invalid request body",
			Data:    []responseData{},
		})
	}

	data.Prompt = strings.TrimSpace(data.Prompt)
	data.ToolID = strings.TrimSpace(data.ToolID)
	if data.Prompt == "" {
		return c.JSON(http.StatusBadRequest, queryProjectResponse{
			Message: "prompt is required",
			Data:    []responseData{},
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, queryProjectResponse{
			Message: "Unauthorized",
			Data:    []responseData{},
		})
	}

	ctx := c.Request().Context()
	trace := graphquery.NewQueryTrace()
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
				Data:    []responseData{},
			})
		}
	}

	_, err := q.GetGroupByProjectId(ctx, data.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, queryProjectResponse{
				Message: "Project or Group not found",
				Data:    []responseData{},
			})
		} else {
			logger.Error("Failed to get group", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{
				Message: "Internal server error",
				Data:    []responseData{},
			})
		}
	}

	conversationID := strings.TrimSpace(data.ConversationID)

	var conversation pgdb.UserChat
	if conversationID == "" {
		publicID, err := gonanoid.New()
		if err != nil {
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
		}

		conversation, err = q.CreateUserChat(ctx, pgdb.CreateUserChatParams{
			PublicID:  publicID,
			UserID:    user.UserID,
			ProjectID: data.ProjectID,
			Title:     buildConversationTitle(data.Prompt),
		})
		if err != nil {
			logger.Error("Failed to create conversation", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
		}
	} else {
		conversation, err = q.GetUserChatByPublicIDAndProject(ctx, pgdb.GetUserChatByPublicIDAndProjectParams{
			PublicID:  conversationID,
			UserID:    user.UserID,
			ProjectID: data.ProjectID,
		})
		if err != nil {
			if err == sql.ErrNoRows {
				return c.JSON(http.StatusNotFound, queryProjectResponse{Message: "Conversation not found", Data: []responseData{}})
			}
			logger.Error("Failed to load conversation", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
		}
	}

	historyRows, err := q.GetChatMessagesByChatID(ctx, conversation.ID)
	if err != nil {
		logger.Error("Failed to load conversation history", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
	}

	chatHistory := make([]ai.ChatMessage, 0, len(historyRows)+1)
	for _, message := range historyRows {
		chatHistory = append(chatHistory, ai.ChatMessage{
			Role:          message.Role,
			Message:       message.Content,
			ToolCallID:    message.ToolCallID,
			ToolName:      message.ToolName,
			ToolArguments: message.ToolArguments,
		})
	}

	pendingToolCall := getPendingToolCall(historyRows)
	promptHandledAsToolResult := false
	if pendingToolCall != nil {
		promptHandledAsToolResult, err = appendPendingToolResult(ctx, q, conversation.ID, &chatHistory, pendingToolCall, data.ToolID, data.Prompt)
		if err != nil {
			logger.Error("Failed to persist pending tool result", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
		}
	}

	if !promptHandledAsToolResult {
		userMessage := ai.ChatMessage{Role: "user", Message: data.Prompt}
		chatHistory = append(chatHistory, userMessage)
		if err := appendChatMessage(ctx, q, conversation.ID, userMessage); err != nil {
			logger.Error("Failed to persist user prompt", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
		}
	}

	msgs := []string{data.Prompt}

	aiClient := c.(*middleware.AppContext).App.AiClient
	storageClient, err := graphstorage.NewGraphDBStorageWithConnection(ctx, conn, aiClient, msgs, graphstorage.WithTracer(trace))
	if err != nil {
		logger.Error("Failed to create graph storage client", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
	}

	prompts, err := q.GetProjectSystemPrompts(ctx, data.ProjectID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Internal server error",
			Data:    []responseData{},
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
	clarificationEnabled := util.GetEnvBool("AI_ENABLE_QUERY_CLARIFICATION", false)
	queryMode := data.Mode
	if pendingToolCall != nil {
		queryMode = "agentic"
	}

	var contentChan <-chan ai.StreamEvent
	switch queryMode {
	case "normal":
		contentChan, err = queryClient.QueryStreamLocal(ctx, chatHistory)
	case "agentic":
		toolList := graphstorage.GetToolList(conn, aiClient, data.ProjectID, trace)
		if clarificationEnabled {
			toolList = append(toolList, graphstorage.GetClarificationTool())
		}
		contentChan, err = queryClient.QueryStreamAgentic(ctx, chatHistory, toolList)
	default:
		contentChan, err = queryClient.QueryStreamLocal(ctx, chatHistory)
	}
	if err != nil {
		logger.Error("[Query] graph error", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Es ist ein interner Fehler aufgetreten.",
			Data:    []responseData{},
		})
	}

	var messageBuffer strings.Builder
	var reasoningBuffer strings.Builder
	var pendingClientToolCall *clientToolCallResponse

	for event := range contentChan {
		switch event.Type {
		case "reasoning":
			reasoningContent := event.Content
			if reasoningContent == "" {
				reasoningContent = event.Reasoning
			}
			if reasoningContent != "" {
				reasoningBuffer.WriteString(reasoningContent)
			}
		case "step":
			if event.Step == "thinking" {
				reasoningContent := event.Content
				if reasoningContent == "" {
					reasoningContent = event.Reasoning
				}
				if reasoningContent != "" {
					reasoningBuffer.WriteString(reasoningContent)
				}
				continue
			}

			if event.Step == "" || event.Step == "db_query" {
				continue
			}

			toolCall := ai.ChatMessage{
				Role:          "assistant_tool_call",
				ToolName:      event.Step,
				ToolCallID:    event.ToolCallID,
				ToolArguments: event.ToolArguments,
			}
			if err := appendChatMessage(ctx, q, conversation.ID, toolCall); err != nil {
				logger.Error("Failed to persist legacy tool call", "err", err)
				return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
			}
		case "tool_call":
			toolCall := ai.ChatMessage{
				Role:          "assistant_tool_call",
				ToolCallID:    event.ToolCallID,
				ToolName:      event.ToolName,
				ToolArguments: event.ToolArguments,
			}
			if err := appendChatMessage(ctx, q, conversation.ID, toolCall); err != nil {
				logger.Error("Failed to persist tool call", "err", err)
				return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
			}
			if event.ToolExecution == ai.ToolExecutionClient {
				pendingClientToolCall = &clientToolCallResponse{
					ToolCallID:    event.ToolCallID,
					ToolName:      event.ToolName,
					ToolArguments: event.ToolArguments,
				}
			}
		case "tool_result":
			result := event.ToolResult
			if result == "" {
				result = event.Content
			}
			toolResult := ai.ChatMessage{
				Role:       "tool",
				Message:    result,
				ToolCallID: event.ToolCallID,
				ToolName:   event.ToolName,
			}
			if err := appendChatMessage(ctx, q, conversation.ID, toolResult); err != nil {
				logger.Error("Failed to persist tool result", "err", err)
				return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
			}
		case "content":
			messageBuffer.WriteString(event.Content)
		}
	}

	if pendingClientToolCall != nil {
		resp := queryProjectResponse{
			ConversationID:      conversation.PublicID,
			Message:             "",
			Data:                []responseData{},
			ClientToolCall:      pendingClientToolCall,
			ConsideredFileCount: 0,
			UsedFileCount:       0,
		}
		if reasoningBuffer.Len() > 0 {
			resp.Reasoning = reasoningBuffer.String()
		}
		return c.JSON(http.StatusOK, resp)
	}

	answer := util.NormalizeIDs(messageBuffer.String())

	assistantMessage := ai.ChatMessage{Role: "assistant", Message: answer}
	if err := appendChatMessage(ctx, q, conversation.ID, assistantMessage); err != nil {
		logger.Error("Failed to persist final assistant message", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []responseData{}})
	}

	fileData := make([]responseData, 0)
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
			Data:    []responseData{},
		})
	}
	for _, file := range files {
		fileData = append(fileData, responseData{
			ID:   file.PublicID,
			Key:  file.FileKey,
			Name: file.Name,
		})
	}

	usedFileKeySet := make(map[string]struct{})
	for _, f := range fileData {
		if f.Key == "" {
			continue
		}
		usedFileKeySet[f.Key] = struct{}{}
	}
	usedFileCount := len(usedFileKeySet)

	consideredFileCount := 0
	if snap := trace.Snapshot(); len(snap.ConsideredSourceIDs) > 0 {
		consideredFiles, err := q.GetFilesFromTextUnitIDs(ctx, snap.ConsideredSourceIDs)
		if err != nil {
			logger.Error("Failed to resolve considered files", "err", err)
		} else {
			consideredFileKeySet := make(map[string]struct{})
			for _, f := range consideredFiles {
				if f.FileKey == "" {
					continue
				}
				consideredFileKeySet[f.FileKey] = struct{}{}
			}
			consideredFileCount = len(consideredFileKeySet)
		}
	}

	resp := queryProjectResponse{
		ConversationID:      conversation.PublicID,
		Message:             answer,
		Data:                fileData,
		ConsideredFileCount: consideredFileCount,
		UsedFileCount:       usedFileCount,
	}
	if reasoningBuffer.Len() > 0 {
		resp.Reasoning = reasoningBuffer.String()
	}

	return c.JSON(http.StatusOK, resp)
}

// QueryProjectStreamHandler handles streaming project queries
func QueryProjectStreamHandler(c echo.Context) error {
	type queryProjectRequest struct {
		ProjectID      int64  `param:"id" validate:"required,numeric"`
		Prompt         string `json:"prompt" validate:"required"`
		ConversationID string `json:"conversation_id"`
		Mode           string `json:"mode"`
		Model          string `json:"model"`
		Think          bool   `json:"think"`
		ToolID         string `json:"tool_id,omitempty"`
	}

	type responseData struct {
		ID   string  `json:"id"`
		Name string  `json:"name"`
		Key  string  `json:"key"`
		Text *string `json:"text,omitempty"`
	}

	data := new(queryProjectRequest)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid request body"})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "Invalid request body"})
	}

	data.Prompt = strings.TrimSpace(data.Prompt)
	data.ToolID = strings.TrimSpace(data.ToolID)
	if data.Prompt == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"message": "prompt is required"})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"message": "Unauthorized"})
	}

	ctx := c.Request().Context()
	trace := graphquery.NewQueryTrace()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			UserID: user.UserID,
			ID:     data.ProjectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, map[string]string{"message": "Unauthorized"})
		}
	}

	_, err := q.GetGroupByProjectId(ctx, data.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, map[string]string{"message": "Project or Group not found"})
		} else {
			logger.Error("Failed to get group", "err", err)
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}
	}

	conversationID := strings.TrimSpace(data.ConversationID)

	var (
		conversation      pgdb.UserChat
		isNewConversation bool
	)

	if conversationID == "" {
		publicID, err := gonanoid.New()
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}

		conversation, err = q.CreateUserChat(ctx, pgdb.CreateUserChatParams{
			PublicID:  publicID,
			UserID:    user.UserID,
			ProjectID: data.ProjectID,
			Title:     buildConversationTitle(data.Prompt),
		})
		if err != nil {
			logger.Error("Failed to create conversation", "err", err)
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}
		isNewConversation = true
	} else {
		conversation, err = q.GetUserChatByPublicIDAndProject(ctx, pgdb.GetUserChatByPublicIDAndProjectParams{
			PublicID:  conversationID,
			UserID:    user.UserID,
			ProjectID: data.ProjectID,
		})
		if err != nil {
			if err == sql.ErrNoRows {
				return c.JSON(http.StatusNotFound, map[string]string{"message": "Conversation not found"})
			}
			logger.Error("Failed to load conversation", "err", err)
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}
		isNewConversation = false
	}

	historyRows, err := q.GetChatMessagesByChatID(ctx, conversation.ID)
	if err != nil {
		logger.Error("Failed to load conversation history", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}

	chatHistory := make([]ai.ChatMessage, 0, len(historyRows)+1)
	for _, message := range historyRows {
		chatHistory = append(chatHistory, ai.ChatMessage{
			Role:          message.Role,
			Message:       message.Content,
			ToolCallID:    message.ToolCallID,
			ToolName:      message.ToolName,
			ToolArguments: message.ToolArguments,
		})
	}

	pendingToolCall := getPendingToolCall(historyRows)
	promptHandledAsToolResult := false
	if pendingToolCall != nil {
		promptHandledAsToolResult, err = appendPendingToolResult(ctx, q, conversation.ID, &chatHistory, pendingToolCall, data.ToolID, data.Prompt)
		if err != nil {
			logger.Error("Failed to persist pending tool result", "err", err)
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}
	}

	if !promptHandledAsToolResult {
		userMessage := ai.ChatMessage{Role: "user", Message: data.Prompt}
		chatHistory = append(chatHistory, userMessage)

		if err := appendChatMessage(ctx, q, conversation.ID, userMessage); err != nil {
			logger.Error("Failed to persist user prompt", "err", err)
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}
	}

	msgs := []string{data.Prompt}

	aiClient := c.(*middleware.AppContext).App.AiClient
	storageClient, err := graphstorage.NewGraphDBStorageWithConnection(ctx, conn, aiClient, msgs, graphstorage.WithTracer(trace))
	if err != nil {
		logger.Error("Failed to create graph storage client", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}

	prompts, err := q.GetProjectSystemPrompts(ctx, data.ProjectID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
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
	clarificationEnabled := util.GetEnvBool("AI_ENABLE_QUERY_CLARIFICATION", false)

	c.Response().Header().Set(echo.HeaderContentType, "text/event-stream")
	c.Response().Header().Set(echo.HeaderCacheControl, "no-cache")
	c.Response().Header().Set("Connection", "keep-alive")
	c.Response().Header().Set("X-Accel-Buffering", "no")
	c.Response().WriteHeader(http.StatusOK)

	if err := writeSSEEvent(c, "conversation", map[string]any{
		"conversation_id": conversation.PublicID,
		"is_new":          isNewConversation,
	}); err != nil {
		return nil
	}

	queryClient := bqc.NewGraphQueryClient(aiClient, storageClient, fmt.Sprintf("%d", data.ProjectID), opts)
	queryMode := data.Mode
	if pendingToolCall != nil {
		queryMode = "agentic"
	}

	var contentChan <-chan ai.StreamEvent
	switch queryMode {
	case "normal":
		contentChan, err = queryClient.QueryStreamLocal(ctx, chatHistory)
	case "agentic":
		toolList := graphstorage.GetToolList(conn, aiClient, data.ProjectID, trace)
		if clarificationEnabled {
			toolList = append(toolList, graphstorage.GetClarificationTool())
		}
		contentChan, err = queryClient.QueryStreamAgentic(ctx, chatHistory, toolList)
	default:
		contentChan, err = queryClient.QueryStreamLocal(ctx, chatHistory)
	}
	if err != nil {
		_ = writeSSEEvent(c, "error", map[string]string{"message": "Es ist ein interner Fehler aufgetreten."})
		_ = writeSSEEvent(c, "done", map[string]any{"conversation_id": conversation.PublicID})
		return nil
	}

	re := regexp.MustCompile(`\[\[([^][]+)\]\]`)
	foundIds := make(map[string]bool)
	var messageBuffer strings.Builder
	var reasoningBuffer strings.Builder
	contentRunesSent := 0
	var allFoundData []responseData
	var pendingClientToolCall *clientToolCallResponse

	for event := range contentChan {
		switch event.Type {
		case "reasoning":
			reasoningContent := event.Content
			if reasoningContent == "" {
				reasoningContent = event.Reasoning
			}
			if reasoningContent == "" {
				continue
			}
			reasoningBuffer.WriteString(reasoningContent)
			if err := writeSSEEvent(c, "reasoning", map[string]string{"content": reasoningContent}); err != nil {
				return nil
			}
		case "step":
			if event.Step == "thinking" {
				reasoningContent := event.Content
				if reasoningContent == "" {
					reasoningContent = event.Reasoning
				}
				if reasoningContent == "" {
					continue
				}
				reasoningBuffer.WriteString(reasoningContent)
				if err := writeSSEEvent(c, "reasoning", map[string]string{"content": reasoningContent}); err != nil {
					return nil
				}
				continue
			}

			if event.Step == "" {
				continue
			}

			if event.Step == "db_query" {
				if err := writeSSEEvent(c, "step", map[string]string{"name": event.Step}); err != nil {
					return nil
				}
				continue
			}

			toolCall := ai.ChatMessage{
				Role:          "assistant_tool_call",
				ToolName:      event.Step,
				ToolCallID:    event.ToolCallID,
				ToolArguments: event.ToolArguments,
			}
			if err := appendChatMessage(ctx, q, conversation.ID, toolCall); err != nil {
				logger.Error("Failed to persist legacy tool call", "err", err)
				_ = writeSSEEvent(c, "error", map[string]string{"message": "Internal server error"})
				return nil
			}

			if err := writeSSEEvent(c, "tool", map[string]string{"name": event.Step}); err != nil {
				return nil
			}
		case "tool_call":
			toolCall := ai.ChatMessage{
				Role:          "assistant_tool_call",
				ToolCallID:    event.ToolCallID,
				ToolName:      event.ToolName,
				ToolArguments: event.ToolArguments,
			}
			if err := appendChatMessage(ctx, q, conversation.ID, toolCall); err != nil {
				logger.Error("Failed to persist tool call", "err", err)
				_ = writeSSEEvent(c, "error", map[string]string{"message": "Internal server error"})
				return nil
			}

			if event.ToolExecution == ai.ToolExecutionClient {
				pendingClientToolCall = &clientToolCallResponse{
					ToolCallID:    event.ToolCallID,
					ToolName:      event.ToolName,
					ToolArguments: event.ToolArguments,
				}
				if err := writeSSEEvent(c, "client_tool_call", pendingClientToolCall); err != nil {
					return nil
				}
				continue
			}

			if err := writeSSEEvent(c, "tool", map[string]string{"name": event.ToolName}); err != nil {
				return nil
			}
		case "tool_result":
			result := event.ToolResult
			if result == "" {
				result = event.Content
			}
			toolResult := ai.ChatMessage{
				Role:       "tool",
				Message:    result,
				ToolCallID: event.ToolCallID,
				ToolName:   event.ToolName,
			}
			if err := appendChatMessage(ctx, q, conversation.ID, toolResult); err != nil {
				logger.Error("Failed to persist tool result", "err", err)
				_ = writeSSEEvent(c, "error", map[string]string{"message": "Internal server error"})
				return nil
			}
		case "content":
			messageBuffer.WriteString(event.Content)
			currentMessage := messageBuffer.String()

			normalizedMessage := util.NormalizeIDs(currentMessage)
			matches := re.FindAllStringSubmatch(normalizedMessage, -1)
			newIDs := make([]string, 0)

			for _, match := range matches {
				id := match[1]
				if !foundIds[id] {
					foundIds[id] = true
					newIDs = append(newIDs, id)
				}
			}

			if len(newIDs) > 0 {
				files, err := q.GetFilesFromTextUnitIDs(ctx, newIDs)
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

			currentMessageRunes := []rune(currentMessage)
			if len(currentMessageRunes) > contentRunesSent {
				delta := string(currentMessageRunes[contentRunesSent:])
				contentRunesSent = len(currentMessageRunes)
				if delta != "" {
					if err := writeSSEEvent(c, "content", map[string]string{"content": delta}); err != nil {
						return nil
					}
				}
			}
		}
	}

	if pendingClientToolCall != nil {
		metrics := aiClient.GetMetrics()
		if err := writeSSEEvent(c, "metrics", metrics); err != nil {
			return nil
		}

		doneData := map[string]any{
			"conversation_id":  conversation.PublicID,
			"message":          "",
			"data":             []responseData{},
			"client_tool_call": pendingClientToolCall,
		}
		if reasoningBuffer.Len() > 0 {
			doneData["reasoning"] = reasoningBuffer.String()
		}

		_ = writeSSEEvent(c, "done", doneData)
		return nil
	}

	finalMessage := util.NormalizeIDs(messageBuffer.String())
	assistantMessage := ai.ChatMessage{Role: "assistant", Message: finalMessage}
	if err := appendChatMessage(ctx, q, conversation.ID, assistantMessage); err != nil {
		logger.Error("Failed to persist final assistant message", "err", err)
		_ = writeSSEEvent(c, "error", map[string]string{"message": "Internal server error"})
		return nil
	}

	metrics := aiClient.GetMetrics()
	if err := writeSSEEvent(c, "metrics", metrics); err != nil {
		return nil
	}

	usedFileKeySet := make(map[string]struct{})
	for _, f := range allFoundData {
		if f.Key == "" {
			continue
		}
		usedFileKeySet[f.Key] = struct{}{}
	}
	usedFileCount := len(usedFileKeySet)

	consideredFileCount := 0
	if snap := trace.Snapshot(); len(snap.ConsideredSourceIDs) > 0 {
		consideredFiles, err := q.GetFilesFromTextUnitIDs(ctx, snap.ConsideredSourceIDs)
		if err != nil {
			logger.Error("Failed to resolve considered files", "err", err)
		} else {
			consideredFileKeySet := make(map[string]struct{})
			for _, f := range consideredFiles {
				if f.FileKey == "" {
					continue
				}
				consideredFileKeySet[f.FileKey] = struct{}{}
			}
			consideredFileCount = len(consideredFileKeySet)
		}
	}

	doneData := map[string]any{
		"conversation_id":       conversation.PublicID,
		"message":               finalMessage,
		"data":                  allFoundData,
		"used_file_count":       usedFileCount,
		"considered_file_count": consideredFileCount,
	}
	if reasoningBuffer.Len() > 0 {
		doneData["reasoning"] = reasoningBuffer.String()
	}

	_ = writeSSEEvent(c, "done", doneData)
	return nil
}

func getPendingToolCall(historyRows []pgdb.ChatMessage) *pgdb.ChatMessage {
	if len(historyRows) == 0 {
		return nil
	}

	last := historyRows[len(historyRows)-1]
	if last.Role != "assistant_tool_call" {
		return nil
	}
	if strings.TrimSpace(last.ToolCallID) == "" {
		return nil
	}

	pending := last
	return &pending
}

func appendPendingToolResult(
	ctx context.Context,
	q *pgdb.Queries,
	chatID int64,
	chatHistory *[]ai.ChatMessage,
	pending *pgdb.ChatMessage,
	toolID string,
	prompt string,
) (bool, error) {
	if pending == nil {
		return false, nil
	}

	result := defaultPendingToolResult
	usedPromptAsToolResult := false
	if strings.TrimSpace(toolID) != "" {
		if toolID != pending.ToolCallID {
			return false, fmt.Errorf("tool_id mismatch: expected %s, got %s", pending.ToolCallID, toolID)
		}
		result = prompt
		usedPromptAsToolResult = true
	}

	toolResult := ai.ChatMessage{
		Role:       "tool",
		Message:    result,
		ToolCallID: pending.ToolCallID,
		ToolName:   pending.ToolName,
	}
	*chatHistory = append(*chatHistory, toolResult)

	if err := appendChatMessage(ctx, q, chatID, toolResult); err != nil {
		return false, err
	}

	return usedPromptAsToolResult, nil
}

func appendChatMessage(ctx context.Context, q *pgdb.Queries, chatID int64, message ai.ChatMessage) error {
	if err := q.AddChatMessage(ctx, pgdb.AddChatMessageParams{
		ChatID:        chatID,
		Role:          message.Role,
		Content:       message.Message,
		ToolCallID:    message.ToolCallID,
		ToolName:      message.ToolName,
		ToolArguments: message.ToolArguments,
	}); err != nil {
		return err
	}

	return q.TouchUserChat(ctx, chatID)
}

func buildConversationTitle(prompt string) string {
	trimmed := strings.TrimSpace(prompt)
	if trimmed == "" {
		return "New conversation"
	}

	const maxTitleLength = 120
	if len(trimmed) <= maxTitleLength {
		return trimmed
	}

	return trimmed[:maxTitleLength]
}

func writeSSEEvent(c echo.Context, event string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	if _, err := fmt.Fprintf(c.Response(), "event: %s\n", event); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(c.Response(), "data: %s\n\n", data); err != nil {
		return err
	}

	c.Response().Flush()
	return nil
}
