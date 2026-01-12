package routes

import (
	"context"
	"fmt"
	"kiwi/internal/db"
	"kiwi/internal/server/middleware"
	"kiwi/internal/storage"
	"kiwi/internal/util"
	"net/http"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"
)

func GetProjectsHandler(c echo.Context) error {
	type project struct {
		ProjectID                int64   `json:"project_id"`
		ProjectName              string  `json:"project_name"`
		ProjectState             string  `json:"project_state"`
		ProcessStep              *string `json:"process_step,omitempty"`
		ProcessPercentage        *int32  `json:"process_percentage,omitempty"`
		ProcessEstimatedDuration *int64  `json:"process_estimated_duration,omitempty"`
		ProcessTimeRemaining     *int64  `json:"process_time_remaining,omitempty"`
	}

	type group struct {
		GroupID   int64     `json:"group_id"`
		GroupName string    `json:"group_name"`
		Role      string    `json:"role"`
		Projects  []project `json:"projects"`
	}

	type projectRow struct {
		GroupID                  int64
		GroupName                string
		ProjectID                int64
		ProjectName              string
		ProjectState             string
		Role                     string
		ProcessStepValid         bool
		ProcessStepString        string
		ProcessPercentageValid   bool
		ProcessPercentageInt32   int32
		ProcessEstimatedDurValid bool
		ProcessEstimatedDurInt64 int64
		ProcessTimeRemaining     any
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := db.New(conn)

	var rows []projectRow

	if middleware.HasPermission(user, "project.view:all") {
		res, err := q.GetAllProjectsWithGroups(ctx)
		if err != nil {
			return c.String(http.StatusInternalServerError, err.Error())
		}
		for _, r := range res {
			rows = append(rows, projectRow{
				GroupID:                  r.GroupID,
				GroupName:                r.GroupName,
				ProjectID:                r.ProjectID,
				ProjectName:              r.ProjectName,
				ProjectState:             r.ProjectState,
				Role:                     r.Role,
				ProcessStepValid:         r.ProcessStep.Valid,
				ProcessStepString:        r.ProcessStep.String,
				ProcessPercentageValid:   r.ProcessPercentage.Valid,
				ProcessPercentageInt32:   r.ProcessPercentage.Int32,
				ProcessEstimatedDurValid: r.ProcessEstimatedDuration.Valid,
				ProcessEstimatedDurInt64: r.ProcessEstimatedDuration.Int64,
				ProcessTimeRemaining:     r.ProcessTimeRemaining,
			})
		}
	} else {
		res, err := q.GetProjectsForUser(ctx, user.UserID)
		if err != nil {
			return c.String(http.StatusInternalServerError, err.Error())
		}
		for _, r := range res {
			rows = append(rows, projectRow{
				GroupID:                  r.GroupID,
				GroupName:                r.GroupName,
				ProjectID:                r.ProjectID,
				ProjectName:              r.ProjectName,
				ProjectState:             r.ProjectState,
				Role:                     r.Role,
				ProcessStepValid:         r.ProcessStep.Valid,
				ProcessStepString:        r.ProcessStep.String,
				ProcessPercentageValid:   r.ProcessPercentage.Valid,
				ProcessPercentageInt32:   r.ProcessPercentage.Int32,
				ProcessEstimatedDurValid: r.ProcessEstimatedDuration.Valid,
				ProcessEstimatedDurInt64: r.ProcessEstimatedDuration.Int64,
				ProcessTimeRemaining:     r.ProcessTimeRemaining,
			})
		}
	}

	var groups []group = make([]group, 0)
	for _, r := range rows {
		id := r.GroupID
		groupIdx := -1
		for i, g := range groups {
			if g.GroupID == id {
				groupIdx = i
				break
			}
		}

		p := project{
			ProjectID:    r.ProjectID,
			ProjectName:  r.ProjectName,
			ProjectState: r.ProjectState,
		}
		if r.ProcessStepValid && r.ProcessStepString != "completed" {
			p.ProcessStep = &r.ProcessStepString
			if r.ProcessPercentageValid {
				p.ProcessPercentage = &r.ProcessPercentageInt32
			}
			if r.ProcessEstimatedDurValid {
				p.ProcessEstimatedDuration = &r.ProcessEstimatedDurInt64
			}
			if r.ProcessTimeRemaining != nil {
				if v, ok := r.ProcessTimeRemaining.(int64); ok {
					p.ProcessTimeRemaining = &v
				}
			}
		}
		if groupIdx == -1 {
			groups = append(groups, group{
				GroupID:   r.GroupID,
				GroupName: r.GroupName,
				Role:      r.Role,
				Projects:  []project{p},
			})
		} else {
			groups[groupIdx].Projects = append(groups[groupIdx].Projects, p)
		}
	}

	aiClient := c.(*middleware.AppContext).App.AiClient
	go func() {
		ctx := context.Background()
		_ = aiClient.LoadModel(ctx)
	}()

	return c.JSON(http.StatusOK, groups)
}

func GetProjectFilesHandler(c echo.Context) error {
	type getProjectFilesParams struct {
		ProjectID int64 `param:"id" validate:"required,numeric"`
	}

	params := new(getProjectFilesParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request params"})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request params"})
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
			ID:     params.ProjectID,
			UserID: user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, map[string]string{"error": "You are not a member of this project"})
		}
	}

	projectFiles, err := q.GetProjectFiles(ctx, params.ProjectID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Internal server error"})
	}

	return c.JSON(http.StatusOK, projectFiles)
}

func GetProjectEventsHandler(c echo.Context) error {
	type getProjectFilesParams struct {
		ProjectID int64 `param:"id" validate:"required,numeric"`
	}

	type getProjectEventsResponse struct {
		Message string `json:"message"`
	}

	params := new(getProjectFilesParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, getProjectEventsResponse{
			Message: "Invalid request params",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, getProjectEventsResponse{
			Message: "Unauthorized",
		})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	queries := db.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := queries.IsUserInProject(ctx, db.IsUserInProjectParams{
			ID:     params.ProjectID,
			UserID: user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, getProjectEventsResponse{
				Message: "You are not a member of this project",
			})
		}
	}

	ch := c.(*middleware.AppContext).App.Queue
	err := ch.ExchangeDeclare(
		"pubsub", // name
		"topic",  // type
		false,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, getProjectEventsResponse{
			Message: "Internal server error",
		})
	}

	q, err := ch.QueueDeclare(
		"",    // name (let server generate a unique name)
		false, // durable
		true,  // autoDelete
		true,  // exclusive
		false, // noWait
		nil,   // args
	)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, getProjectEventsResponse{
			Message: "Internal server error",
		})
	}

	routingKey := fmt.Sprintf("project_%d", params.ProjectID)
	if err := ch.QueueBind(
		q.Name,     // queue
		routingKey, // key
		"pubsub",   // exchange
		false,      // noWait
		nil,        // args
	); err != nil {
		return c.JSON(http.StatusInternalServerError, getProjectEventsResponse{
			Message: "Internal server error",
		})
	}

	msgs, err := ch.Consume(
		q.Name, // queue
		"",     // consumer
		true,   // autoAck
		true,   // exclusive
		false,  // noLocal
		false,  // noWait
		nil,    // args
	)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, getProjectEventsResponse{
			Message: "Internal server error",
		})
	}

	w := c.Response()
	r := c.Request()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ctx = r.Context()
	for {
		select {
		case msg := <-msgs:
			event := util.Event{
				Event: []byte("message"),
				Data:  []byte(msg.Body),
				ID:    []byte(msg.MessageId),
			}
			if err := event.MarshalTo(w); err != nil {
				return err
			}
			w.Flush()
		case <-ctx.Done():
			return nil
		}
	}
}

func GetTextUnitHandler(c echo.Context) error {
	type getTextUnitParams struct {
		ID string `param:"unit_id" validate:"required"`
	}

	type getTextUnitResponse struct {
		Message string       `json:"message"`
		Unit    *db.TextUnit `json:"data,omitempty"`
	}

	params := new(getTextUnitParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, getTextUnitResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, getTextUnitResponse{
			Message: "Invalid request params",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, getTextUnitResponse{
			Message: "Unauthorized",
		})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	qtx := db.New(conn)

	projectID, err := qtx.GetProjectIDFromTextUnit(ctx, params.ID)
	if err != nil {
		return c.JSON(http.StatusNotFound, getTextUnitResponse{
			Message: "Text unit not found",
		})
	}

	if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInProject(ctx, db.IsUserInProjectParams{
			UserID: user.UserID,
			ID:     projectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, getTextUnitResponse{
				Message: "Unauthorized",
			})
		}
	}

	unit, err := qtx.GetTextUnitByPublicId(ctx, params.ID)
	if err != nil {
		return c.JSON(http.StatusNotFound, getTextUnitResponse{
			Message: "Text unit not found",
		})
	}

	return c.JSON(http.StatusOK, getTextUnitResponse{
		Message: "Text unit found",
		Unit:    &unit,
	})
}

func GetProjectFile(c echo.Context) error {
	type getProjectFileParams struct {
		ProjectID int64  `param:"id" validate:"required,numeric"`
		FileKey   string `json:"file_key" validate:"required"`
	}

	type getProjectFileResponse struct {
		Message string `json:"message"`
	}

	params := new(getProjectFileParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, getProjectFileResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, getProjectFileResponse{
			Message: "Invalid request params",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, getProjectFileResponse{
			Message: "Unauthorized",
		})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	qtx := db.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInProject(ctx, db.IsUserInProjectParams{
			UserID: user.UserID,
			ID:     params.ProjectID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, getProjectFileResponse{
				Message: "Unauthorized",
			})
		}
	}

	s3Client := c.(*middleware.AppContext).App.S3

	url, err := storage.GenerateDownloadLink(ctx, s3Client, params.FileKey)
	if err != nil {
		return c.JSON(http.StatusNotFound, getProjectFileResponse{
			Message: "File does not exist",
		})
	}

	return c.JSON(http.StatusOK, getProjectFileResponse{
		Message: url,
	})
}
