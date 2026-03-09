package routes

import (
	"database/sql"
	"net/http"
	"strings"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	serverutil "github.com/OFFIS-RIT/kiwi/backend/internal/server/util"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphquery "github.com/OFFIS-RIT/kiwi/backend/pkg/query"
	bqc "github.com/OFFIS-RIT/kiwi/backend/pkg/query/pgx"
	graphstorage "github.com/OFFIS-RIT/kiwi/backend/pkg/store/pgx"
	"github.com/jackc/pgx/v5/pgtype"
)

type clientToolCallResponse struct {
	ToolCallID    string `json:"tool_call_id"`
	ToolName      string `json:"tool_name"`
	ToolArguments string `json:"tool_arguments"`
}

type projectQueryRequest struct {
	ProjectID      string `param:"id" validate:"required"`
	Prompt         string `json:"prompt" validate:"required"`
	ConversationID string `json:"conversation_id"`
	Mode           string `json:"mode"`
	Model          string `json:"model"`
	Think          bool   `json:"think"`
	ToolID         string `json:"tool_id,omitempty"`
}

type projectQueryResponseData struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Key  string  `json:"key"`
	Text *string `json:"text,omitempty"`
}

type queryProjectResponse struct {
	ConversationID      string                     `json:"conversation_id"`
	Message             string                     `json:"message"`
	Data                []projectQueryResponseData `json:"data"`
	ClientToolCall      *clientToolCallResponse    `json:"client_tool_call,omitempty"`
	Reasoning           string                     `json:"reasoning,omitempty"`
	ConsideredFileCount int                        `json:"considered_file_count"`
	UsedFileCount       int                        `json:"used_file_count"`
}

// CreateProjectHandler creates a new project from multipart/form-data
func CreateProjectHandler(c echo.Context) error {
	type createProjectBody struct {
		GroupID string `form:"group_id" validate:"required"`
		Name    string `form:"name" validate:"required"`
	}

	type createProjectResponse struct {
		Message      string              `json:"message"`
		Project      *pgdb.Graph         `json:"project,omitempty"`
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

	data.Name = strings.TrimSpace(data.Name)
	if data.Name == "" {
		return c.JSON(http.StatusBadRequest, createProjectResponse{
			Message: "Invalid request body",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, createProjectResponse{
			Message: "Unauthorized",
		})
	}

	if data.GroupID == "" {
		return c.JSON(http.StatusBadRequest, createProjectResponse{
			Message: "group_id is required",
		})
	}

	form, err := c.MultipartForm()
	if err != nil {
		return c.JSON(http.StatusBadRequest, createProjectResponse{
			Message: "Invalid request body",
		})
	}
	uploads := form.File["files"]

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

	state := "create"
	if len(uploads) == 0 {
		state = "ready"
	}

	project, err := qtx.CreateProject(ctx, pgdb.CreateProjectParams{
		ID:      ids.New(),
		GroupID: pgtype.Text{String: data.GroupID, Valid: true},
		Name:    data.Name,
		State:   state,
	})
	if err != nil {
		logger.Error("Failed to create project", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{
			Message: "Internal server error",
		})
	}

	err = qtx.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
		ID:            ids.New(),
		ProjectID:     project.ID,
		UpdateType:    "create",
		UpdateMessage: util.ConvertStructToJson(project),
	})
	if err != nil {
		logger.Error("Failed to add project update", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{
			Message: "Internal server error",
		})
	}

	s3Client := c.(*middleware.AppContext).App.S3
	uploadedFiles, err := uploadProjectFiles(ctx, s3Client, project.ID, uploads)
	if err != nil {
		logger.Error("Failed to upload project files", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{Message: "Internal server error"})
	}

	projectFiles, err := createProjectFiles(ctx, qtx, project.ID, uploadedFiles)
	if err != nil {
		logger.Error("Failed to create project files", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{Message: "Internal server error"})
	}

	if _, err := c.(*middleware.AppContext).App.Workflows.EnqueueProcessFiles(ctx, tx, project.ID, projectFiles, "index"); err != nil {
		logger.Error("Failed to enqueue project workflows", "err", err)
		return c.JSON(http.StatusInternalServerError, createProjectResponse{Message: "Internal server error"})
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

	if len(projectFiles) == 0 {
		return c.JSON(
			http.StatusOK,
			resp,
		)
	}

	return c.JSON(
		http.StatusOK,
		resp,
	)
}

// AddFilesToProjectHandler adds files to an existing project (multipart/form-data)
func AddFilesToProjectHandler(c echo.Context) error {
	type addFilesParams struct {
		ProjectID string `param:"id" validate:"required"`
	}

	type addFilesResponse struct {
		Message      string              `json:"message"`
		ProjectID    string              `json:"project_id"`
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

	project, err := q.GetProjectByID(ctx, params.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, addFilesResponse{
				Message: "Project not found",
			})
		} else {
			logger.Error("Failed to get project", "err", err)
			return c.JSON(http.StatusInternalServerError, addFilesResponse{
				Message: "Internal server error",
			})
		}
	}

	if project.UserID.Valid {
		if project.UserID.String != user.UserID {
			return c.JSON(http.StatusForbidden, addFilesResponse{Message: "You are not allowed to modify this project"})
		}
	} else if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			ID:     params.ProjectID,
			UserID: pgtype.Text{String: user.UserID, Valid: true},
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, addFilesResponse{Message: "You are not allowed to modify this project"})
		}
	}

	s3Client := c.(*middleware.AppContext).App.S3
	uploadedFiles, err := uploadProjectFiles(ctx, s3Client, params.ProjectID, uploads)
	if err != nil {
		logger.Error("Failed to upload project files", "err", err)
		return c.JSON(http.StatusInternalServerError, addFilesResponse{Message: "Internal server error"})
	}

	tx, err := conn.Begin(ctx)
	if err != nil {
		logger.Error("Failed to begin transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, addFilesResponse{Message: "Internal server error"})
	}
	defer tx.Rollback(ctx)
	qtx := q.WithTx(tx)

	projectFiles, err := createProjectFiles(ctx, qtx, params.ProjectID, uploadedFiles)
	if err != nil {
		logger.Error("Failed to create project files", "err", err)
		return c.JSON(http.StatusInternalServerError, addFilesResponse{Message: "Failed to add file to project"})
	}
	if _, err := c.(*middleware.AppContext).App.Workflows.EnqueueProcessFiles(ctx, tx, params.ProjectID, projectFiles, "update"); err != nil {
		logger.Error("Failed to enqueue update workflows", "err", err)
		return c.JSON(http.StatusInternalServerError, addFilesResponse{Message: "Failed to add file to project"})
	}
	if err := tx.Commit(ctx); err != nil {
		logger.Error("Failed to commit file upload transaction", "err", err)
		return c.JSON(http.StatusInternalServerError, addFilesResponse{Message: "Failed to add file to project"})
	}

	resp := addFilesResponse{
		Message:      "File added successfully",
		ProjectID:    params.ProjectID,
		ProjectFiles: make([]*pgdb.ProjectFile, 0, len(projectFiles)),
	}
	for i := range projectFiles {
		resp.ProjectFiles = append(resp.ProjectFiles, &projectFiles[i])
	}

	return c.JSON(
		http.StatusOK,
		resp,
	)
}

// QueryProjectHandler handles project queries
func QueryProjectHandler(c echo.Context) error {
	data := new(projectQueryRequest)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, queryProjectResponse{
			Message: "Invalid request body",
			Data:    []projectQueryResponseData{},
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, queryProjectResponse{
			Message: "Invalid request body",
			Data:    []projectQueryResponseData{},
		})
	}

	data.Prompt = strings.TrimSpace(data.Prompt)
	data.ToolID = strings.TrimSpace(data.ToolID)
	if data.Prompt == "" {
		return c.JSON(http.StatusBadRequest, queryProjectResponse{
			Message: "prompt is required",
			Data:    []projectQueryResponseData{},
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, queryProjectResponse{
			Message: "Unauthorized",
			Data:    []projectQueryResponseData{},
		})
	}

	ctx := c.Request().Context()
	trace := graphquery.NewQueryTrace()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	project, err := q.GetProjectByID(ctx, data.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, queryProjectResponse{
				Message: "Project not found",
				Data:    []projectQueryResponseData{},
			})
		} else {
			logger.Error("Failed to get project", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{
				Message: "Internal server error",
				Data:    []projectQueryResponseData{},
			})
		}
	}

	if project.UserID.Valid {
		if project.UserID.String != user.UserID {
			return c.JSON(http.StatusForbidden, queryProjectResponse{Message: "Unauthorized", Data: []projectQueryResponseData{}})
		}
	} else if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			UserID: pgtype.Text{String: user.UserID, Valid: true},
			ID:     data.ProjectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, queryProjectResponse{Message: "Unauthorized", Data: []projectQueryResponseData{}})
		}
	}

	if project.Type.Valid {
		return c.JSON(http.StatusForbidden, queryProjectResponse{
			Message: "This graph is not accessible for direct access",
			Data:    []projectQueryResponseData{},
		})
	}

	conversationID := strings.TrimSpace(data.ConversationID)

	var conversation pgdb.UserChat
	if conversationID == "" {
		conversation, err = q.CreateUserChat(ctx, pgdb.CreateUserChatParams{
			ID:        ids.New(),
			UserID:    user.UserID,
			ProjectID: pgtype.Text{String: data.ProjectID, Valid: true},
			Title:     serverutil.BuildConversationTitle(data.Prompt),
		})
		if err != nil {
			logger.Error("Failed to create conversation", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []projectQueryResponseData{}})
		}
	} else {
		conversation, err = q.GetUserChatByIDAndProject(ctx, pgdb.GetUserChatByIDAndProjectParams{
			ID:        conversationID,
			UserID:    user.UserID,
			ProjectID: pgtype.Text{String: data.ProjectID, Valid: true},
		})
		if err != nil {
			if err == sql.ErrNoRows {
				return c.JSON(http.StatusNotFound, queryProjectResponse{Message: "Conversation not found", Data: []projectQueryResponseData{}})
			}
			logger.Error("Failed to load conversation", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []projectQueryResponseData{}})
		}
	}

	historyRows, err := q.GetChatMessagesByChatID(ctx, conversation.ID)
	if err != nil {
		logger.Error("Failed to load conversation history", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []projectQueryResponseData{}})
	}

	chatHistory := make([]ai.ChatMessage, 0, len(historyRows)+1)
	for _, message := range historyRows {
		chatHistory = append(chatHistory, ai.ChatMessage{
			Role:          message.Role,
			Message:       message.Content,
			ToolCallID:    message.ToolCallID,
			ToolName:      message.ToolName,
			ToolArguments: message.ToolArguments,
			ToolExecution: ai.ToolExecution(message.ToolExecution),
		})
	}

	pendingToolCall := serverutil.GetPendingToolCall(historyRows)
	promptHandledAsToolResult := false
	if pendingToolCall != nil {
		promptHandledAsToolResult, err = serverutil.AppendPendingToolResult(ctx, q, conversation.ID, &chatHistory, pendingToolCall, data.ToolID, data.Prompt)
		if err != nil {
			logger.Error("Failed to persist pending tool result", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []projectQueryResponseData{}})
		}
	}

	if !promptHandledAsToolResult {
		userMessage := ai.ChatMessage{Role: "user", Message: data.Prompt}
		chatHistory = append(chatHistory, userMessage)
		if err := serverutil.AppendChatMessage(ctx, q, conversation.ID, userMessage); err != nil {
			logger.Error("Failed to persist user prompt", "err", err)
			return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []projectQueryResponseData{}})
		}
	}

	msgs := []string{data.Prompt}

	aiClient := c.(*middleware.AppContext).App.AiClient
	storageClient, err := graphstorage.NewGraphDBStorageWithConnection(ctx, conn, aiClient, msgs, graphstorage.WithTracer(trace))
	if err != nil {
		logger.Error("Failed to create graph storage client", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []projectQueryResponseData{}})
	}

	prompts, err := q.GetProjectSystemPrompts(ctx, data.ProjectID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Internal server error",
			Data:    []projectQueryResponseData{},
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

	expertProjects, err := q.GetAvailableExpertProjects(ctx, pgdb.GetAvailableExpertProjectsParams{
		CurrentProjectID: pgtype.Text{String: data.ProjectID, Valid: true},
		UserID:           pgtype.Text{String: user.UserID, Valid: true},
	})
	if err != nil {
		logger.Error("Failed to load expert graph catalog", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Internal server error",
			Data:    []projectQueryResponseData{},
		})
	}
	expertGraphCatalog := serverutil.BuildExpertGraphCatalog(data.ProjectID, expertProjects)
	opts = append(opts, bqc.WithExpertGraphCatalog(expertGraphCatalog))

	queryClient := bqc.NewGraphQueryClient(aiClient, storageClient, data.ProjectID, opts)
	queryMode := data.Mode
	if pendingToolCall != nil {
		queryMode = "agentic"
	}

	toolList := []ai.Tool(nil)
	if queryMode == "agentic" {
		toolList = graphstorage.GetServerToolList(conn, aiClient, data.ProjectID, user.UserID, trace, true)
	}

	answer, err := serverutil.ExecuteBlockingProjectQuery(ctx, queryClient, queryMode, chatHistory, toolList)
	if err != nil {
		logger.Error("[Query] graph error", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Es ist ein interner Fehler aufgetreten.",
			Data:    []projectQueryResponseData{},
		})
	}

	answer = util.NormalizeIDs(answer)
	reasoning := ""
	metrics := aiClient.GetMetrics()

	if err := serverutil.AppendAssistantChatMessage(ctx, q, conversation.ID, answer, reasoning, &metrics); err != nil {
		logger.Error("Failed to persist final assistant message", "err", err)
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{Message: "Internal server error", Data: []projectQueryResponseData{}})
	}

	citationData, err := serverutil.ResolveCitationData(ctx, q, data.ProjectID, serverutil.ExtractCitationIDs(answer))
	if err != nil {
		return c.JSON(http.StatusInternalServerError, queryProjectResponse{
			Message: "Internal server error",
			Data:    []projectQueryResponseData{},
		})
	}

	responseData := make([]projectQueryResponseData, 0, len(citationData))
	usedFileKeySet := make(map[string]struct{})
	for _, file := range citationData {
		responseData = append(responseData, projectQueryResponseData{
			ID:   file.ID,
			Key:  file.Key,
			Name: file.Name,
		})
		if file.Key == "" {
			continue
		}
		usedFileKeySet[file.Key] = struct{}{}
	}

	consideredFileCount := 0
	if snap := trace.Snapshot(); len(snap.ConsideredSourceIDs) > 0 {
		consideredFiles, err := q.GetFilesFromTextUnitIDs(ctx, pgdb.GetFilesFromTextUnitIDsParams{
			SourceIds: snap.ConsideredSourceIDs,
			ProjectID: data.ProjectID,
		})
		if err != nil {
			logger.Error("Failed to resolve considered files", "err", err)
		} else {
			consideredFileKeySet := make(map[string]struct{})
			for _, file := range consideredFiles {
				if file.FileKey == "" {
					continue
				}
				consideredFileKeySet[file.FileKey] = struct{}{}
			}
			consideredFileCount = len(consideredFileKeySet)
		}
	}

	resp := queryProjectResponse{
		ConversationID:      conversation.ID,
		Message:             answer,
		Data:                responseData,
		UsedFileCount:       len(usedFileKeySet),
		ConsideredFileCount: consideredFileCount,
	}
	if reasoning != "" {
		resp.Reasoning = reasoning
	}

	return c.JSON(http.StatusOK, resp)
}

// QueryProjectStreamHandler handles streaming project queries
func QueryProjectStreamHandler(c echo.Context) error {
	data := new(projectQueryRequest)
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

	project, err := q.GetProjectByID(ctx, data.ProjectID)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.JSON(http.StatusNotFound, map[string]string{"message": "Project not found"})
		} else {
			logger.Error("Failed to get project", "err", err)
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}
	}

	if project.UserID.Valid {
		if project.UserID.String != user.UserID {
			return c.JSON(http.StatusForbidden, map[string]string{"message": "Unauthorized"})
		}
	} else if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
			UserID: pgtype.Text{String: user.UserID, Valid: true},
			ID:     data.ProjectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, map[string]string{"message": "Unauthorized"})
		}
	}

	if project.Type.Valid {
		return c.JSON(http.StatusForbidden, map[string]string{"message": "This graph is not accessible for direct access"})
	}

	conversationID := strings.TrimSpace(data.ConversationID)

	var (
		conversation      pgdb.UserChat
		isNewConversation bool
	)

	if conversationID == "" {
		conversation, err = q.CreateUserChat(ctx, pgdb.CreateUserChatParams{
			ID:        ids.New(),
			UserID:    user.UserID,
			ProjectID: pgtype.Text{String: data.ProjectID, Valid: true},
			Title:     serverutil.BuildConversationTitle(data.Prompt),
		})
		if err != nil {
			logger.Error("Failed to create conversation", "err", err)
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}
		isNewConversation = true
	} else {
		conversation, err = q.GetUserChatByIDAndProject(ctx, pgdb.GetUserChatByIDAndProjectParams{
			ID:        conversationID,
			UserID:    user.UserID,
			ProjectID: pgtype.Text{String: data.ProjectID, Valid: true},
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
			ToolExecution: ai.ToolExecution(message.ToolExecution),
		})
	}

	pendingToolCall := serverutil.GetPendingToolCall(historyRows)
	promptHandledAsToolResult := false
	if pendingToolCall != nil {
		promptHandledAsToolResult, err = serverutil.AppendPendingToolResult(ctx, q, conversation.ID, &chatHistory, pendingToolCall, data.ToolID, data.Prompt)
		if err != nil {
			logger.Error("Failed to persist pending tool result", "err", err)
			return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
		}
	}

	if !promptHandledAsToolResult {
		userMessage := ai.ChatMessage{Role: "user", Message: data.Prompt}
		chatHistory = append(chatHistory, userMessage)

		if err := serverutil.AppendChatMessage(ctx, q, conversation.ID, userMessage); err != nil {
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

	expertProjects, err := q.GetAvailableExpertProjects(ctx, pgdb.GetAvailableExpertProjectsParams{
		CurrentProjectID: pgtype.Text{String: data.ProjectID, Valid: true},
		UserID:           pgtype.Text{String: user.UserID, Valid: true},
	})
	if err != nil {
		logger.Error("Failed to load expert graph catalog", "err", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"message": "Internal server error"})
	}
	expertGraphCatalog := serverutil.BuildExpertGraphCatalog(data.ProjectID, expertProjects)
	opts = append(opts, bqc.WithExpertGraphCatalog(expertGraphCatalog))
	clarificationEnabled := util.GetEnvBool("AI_ENABLE_QUERY_CLARIFICATION", false)

	c.Response().Header().Set(echo.HeaderContentType, "text/event-stream")
	c.Response().Header().Set(echo.HeaderCacheControl, "no-cache")
	c.Response().Header().Set("Connection", "keep-alive")
	c.Response().Header().Set("X-Accel-Buffering", "no")
	c.Response().WriteHeader(http.StatusOK)

	if err := serverutil.WriteSSEEvent(c, "conversation", map[string]any{
		"conversation_id": conversation.ID,
		"is_new":          isNewConversation,
	}); err != nil {
		return nil
	}

	queryClient := bqc.NewGraphQueryClient(aiClient, storageClient, data.ProjectID, opts)
	queryMode := data.Mode
	if pendingToolCall != nil {
		queryMode = "agentic"
	}

	var contentChan <-chan ai.StreamEvent
	switch queryMode {
	case "normal":
		contentChan, err = queryClient.QueryStreamLocal(ctx, chatHistory)
	case "agentic":
		toolList := graphstorage.GetServerToolList(conn, aiClient, data.ProjectID, user.UserID, trace, true)
		if clarificationEnabled {
			toolList = graphstorage.GetCombinedToolList(conn, aiClient, data.ProjectID, user.UserID, trace, true)
		}
		contentChan, err = queryClient.QueryStreamAgentic(ctx, chatHistory, toolList)
	default:
		contentChan, err = queryClient.QueryStreamLocal(ctx, chatHistory)
	}
	if err != nil {
		_ = serverutil.WriteSSEEvent(c, "error", map[string]string{"message": "Es ist ein interner Fehler aufgetreten."})
		_ = serverutil.WriteSSEEvent(c, "done", map[string]any{"conversation_id": conversation.ID})
		return nil
	}

	resolvedCitationIDs := make(map[string]bool)
	citationCache := make(map[string]*projectQueryResponseData)
	var messageBuffer strings.Builder
	var reasoningBuffer strings.Builder
	var allFoundData []projectQueryResponseData
	var pendingClientToolCall *clientToolCallResponse
	var pendingClientToolCallReasoning string
	citationParser := serverutil.StreamCitationParser{}

	resolveCitationTextUnitData := func(id string) *projectQueryResponseData {
		if cached, ok := citationCache[id]; ok {
			return cached
		}

		citationData, err := serverutil.ResolveCitationData(ctx, q, data.ProjectID, []string{id})
		if err != nil {
			logger.Error("Error getting files for citation", "id", id, "err", err)
			citationCache[id] = nil
			return nil
		}
		if len(citationData) == 0 {
			citationCache[id] = nil
			return nil
		}

		resolved := projectQueryResponseData{
			ID:   citationData[0].ID,
			Key:  citationData[0].Key,
			Name: citationData[0].Name,
		}
		citationCache[id] = &resolved
		return &resolved
	}

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
			if err := serverutil.WriteSSEEvent(c, "reasoning", map[string]string{"content": reasoningContent}); err != nil {
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
				if err := serverutil.WriteSSEEvent(c, "reasoning", map[string]string{"content": reasoningContent}); err != nil {
					return nil
				}
				continue
			}

			if event.Step == "" {
				continue
			}

			if event.Step == "db_query" {
				if err := serverutil.WriteSSEEvent(c, "step", map[string]string{"name": event.Step}); err != nil {
					return nil
				}
				continue
			}

			toolCall := ai.ChatMessage{
				Role:          "assistant_tool_call",
				ToolName:      event.Step,
				ToolCallID:    event.ToolCallID,
				ToolArguments: event.ToolArguments,
				ToolExecution: ai.ToolExecutionServer,
				Reasoning:     reasoningBuffer.String(),
			}
			if err := serverutil.AppendChatMessage(ctx, q, conversation.ID, toolCall); err != nil {
				logger.Error("Failed to persist legacy tool call", "err", err)
				_ = serverutil.WriteSSEEvent(c, "error", map[string]string{"message": "Internal server error"})
				return nil
			}
			reasoningBuffer.Reset()

			if err := serverutil.WriteSSEEvent(c, "tool", map[string]string{"name": event.Step}); err != nil {
				return nil
			}
		case "tool_call":
			reasoningForToolCall := reasoningBuffer.String()
			toolCall := ai.ChatMessage{
				Role:          "assistant_tool_call",
				ToolCallID:    event.ToolCallID,
				ToolName:      event.ToolName,
				ToolArguments: event.ToolArguments,
				ToolExecution: event.ToolExecution,
				Reasoning:     reasoningForToolCall,
			}
			if err := serverutil.AppendChatMessage(ctx, q, conversation.ID, toolCall); err != nil {
				logger.Error("Failed to persist tool call", "err", err)
				_ = serverutil.WriteSSEEvent(c, "error", map[string]string{"message": "Internal server error"})
				return nil
			}
			reasoningBuffer.Reset()

			if event.ToolExecution == ai.ToolExecutionClient {
				pendingClientToolCall = &clientToolCallResponse{
					ToolCallID:    event.ToolCallID,
					ToolName:      event.ToolName,
					ToolArguments: event.ToolArguments,
				}
				pendingClientToolCallReasoning = reasoningForToolCall
				if err := serverutil.WriteSSEEvent(c, "client_tool_call", pendingClientToolCall); err != nil {
					return nil
				}
				continue
			}

			if err := serverutil.WriteSSEEvent(c, "tool", map[string]string{"name": event.ToolName}); err != nil {
				return nil
			}
		case "tool_result":
			result := event.ToolResult
			if result == "" {
				result = event.Content
			}
			toolResult := ai.ChatMessage{
				Role:          "tool",
				Message:       result,
				ToolCallID:    event.ToolCallID,
				ToolName:      event.ToolName,
				ToolExecution: event.ToolExecution,
			}
			if err := serverutil.AppendChatMessage(ctx, q, conversation.ID, toolResult); err != nil {
				logger.Error("Failed to persist tool result", "err", err)
				_ = serverutil.WriteSSEEvent(c, "error", map[string]string{"message": "Internal server error"})
				return nil
			}
		case "content":
			messageBuffer.WriteString(event.Content)

			if err := citationParser.Consume(
				event.Content,
				func(content string) error {
					if content == "" {
						return nil
					}
					return serverutil.WriteSSEEvent(c, "content", map[string]string{"content": content})
				},
				func(citationID string) error {
					citationData := resolveCitationTextUnitData(citationID)
					if citationData != nil && !resolvedCitationIDs[citationID] {
						resolvedCitationIDs[citationID] = true
						allFoundData = append(allFoundData, *citationData)
					}

					payload := map[string]any{"id": citationID}
					if citationData != nil {
						payload["name"] = citationData.Name
						payload["key"] = citationData.Key
						if citationData.Text != nil {
							payload["text"] = citationData.Text
						}
					}

					return serverutil.WriteSSEEvent(c, "citation", payload)
				},
			); err != nil {
				return nil
			}
		}
	}

	if err := citationParser.Flush(func(content string) error {
		if content == "" {
			return nil
		}
		return serverutil.WriteSSEEvent(c, "content", map[string]string{"content": content})
	}); err != nil {
		return nil
	}

	if pendingClientToolCall != nil {
		metrics := aiClient.GetMetrics()
		if err := serverutil.WriteSSEEvent(c, "metrics", metrics); err != nil {
			return nil
		}

		doneData := map[string]any{
			"conversation_id":  conversation.ID,
			"message":          "",
			"data":             []projectQueryResponseData{},
			"client_tool_call": pendingClientToolCall,
		}
		if pendingClientToolCallReasoning != "" {
			doneData["reasoning"] = pendingClientToolCallReasoning
		} else if reasoningBuffer.Len() > 0 {
			doneData["reasoning"] = reasoningBuffer.String()
		}

		_ = serverutil.WriteSSEEvent(c, "done", doneData)
		return nil
	}

	finalMessage := util.NormalizeIDs(messageBuffer.String())
	reasoning := reasoningBuffer.String()
	metrics := aiClient.GetMetrics()
	if err := serverutil.AppendAssistantChatMessage(ctx, q, conversation.ID, finalMessage, reasoning, &metrics); err != nil {
		logger.Error("Failed to persist final assistant message", "err", err)
		_ = serverutil.WriteSSEEvent(c, "error", map[string]string{"message": "Internal server error"})
		return nil
	}

	for _, citationID := range serverutil.ExtractCitationIDs(finalMessage) {
		if resolvedCitationIDs[citationID] {
			continue
		}

		citationData := resolveCitationTextUnitData(citationID)
		if citationData == nil {
			continue
		}

		resolvedCitationIDs[citationID] = true
		allFoundData = append(allFoundData, *citationData)
	}

	if err := serverutil.WriteSSEEvent(c, "metrics", metrics); err != nil {
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
		consideredFiles, err := q.GetFilesFromTextUnitIDs(ctx, pgdb.GetFilesFromTextUnitIDsParams{
			SourceIds: snap.ConsideredSourceIDs,
			ProjectID: data.ProjectID,
		})
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
		"conversation_id":       conversation.ID,
		"message":               finalMessage,
		"data":                  allFoundData,
		"used_file_count":       usedFileCount,
		"considered_file_count": consideredFileCount,
	}
	if reasoningBuffer.Len() > 0 {
		doneData["reasoning"] = reasoningBuffer.String()
	}

	_ = serverutil.WriteSSEEvent(c, "done", doneData)
	return nil
}
