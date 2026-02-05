package routes

import (
	"context"
	"net/http"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"
)

func GetProjectsHandler(c echo.Context) error {
	type project struct {
		ProjectID                int64                   `json:"project_id"`
		ProjectName              string                  `json:"project_name"`
		ProjectState             string                  `json:"project_state"`
		ProcessStep              *util.BatchStepProgress `json:"process_step,omitempty"`
		ProcessPercentage        *int32                  `json:"process_percentage,omitempty"`
		ProcessEstimatedDuration *int64                  `json:"process_estimated_duration,omitempty"`
		ProcessTimeRemaining     *int64                  `json:"process_time_remaining,omitempty"`
	}

	type group struct {
		GroupID   int64     `json:"group_id"`
		GroupName string    `json:"group_name"`
		Role      string    `json:"role"`
		Projects  []project `json:"projects"`
	}

	type projectRow struct {
		GroupID      int64
		GroupName    string
		ProjectID    int64
		ProjectName  string
		ProjectState string
		Role         string
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	var rows []projectRow

	if middleware.HasPermission(user, "project.view:all") {
		res, err := q.GetAllProjectsWithGroups(ctx)
		if err != nil {
			return c.String(http.StatusInternalServerError, err.Error())
		}
		for _, r := range res {
			rows = append(rows, projectRow{
				GroupID:      r.GroupID,
				GroupName:    r.GroupName,
				ProjectID:    r.ProjectID,
				ProjectName:  r.ProjectName,
				ProjectState: r.ProjectState,
				Role:         r.Role,
			})
		}
	} else {
		res, err := q.GetProjectsForUser(ctx, user.UserID)
		if err != nil {
			return c.String(http.StatusInternalServerError, err.Error())
		}
		for _, r := range res {
			rows = append(rows, projectRow{
				GroupID:      r.GroupID,
				GroupName:    r.GroupName,
				ProjectID:    r.ProjectID,
				ProjectName:  r.ProjectName,
				ProjectState: r.ProjectState,
				Role:         r.Role,
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

		if r.ProjectState != "ready" {
			correlationID, err := q.GetLatestCorrelationForProject(ctx, r.ProjectID)
			if err == nil && correlationID != "" {
				progress, err := q.GetProjectFullProgress(ctx, correlationID)
				if err == nil {
					batchProgress := util.BuildBatchProgress(progress)
					if batchProgress.Step != nil {
						p.ProcessStep = batchProgress.Step
					}
					if batchProgress.Percentage != nil {
						p.ProcessPercentage = batchProgress.Percentage
					}
					if batchProgress.EstimatedDuration != nil {
						p.ProcessEstimatedDuration = batchProgress.EstimatedDuration
					}
					if batchProgress.TimeRemaining != nil {
						p.ProcessTimeRemaining = batchProgress.TimeRemaining
					}
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
	q := pgdb.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
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

	fileIDs := make([]int64, 0, len(projectFiles))
	for _, f := range projectFiles {
		fileIDs = append(fileIDs, f.ID)
	}

	batchStatusByFileID := make(map[int64]string, len(fileIDs))
	if len(fileIDs) > 0 {
		rows, err := q.GetLatestBatchStatusForFiles(ctx, pgdb.GetLatestBatchStatusForFilesParams{
			ProjectID: params.ProjectID,
			FileIds:   fileIDs,
		})
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Internal server error"})
		}
		for _, r := range rows {
			batchStatusByFileID[r.FileID] = r.Status
		}
	}

	type projectFileResponse struct {
		pgdb.ProjectFile
		Status string `json:"status"`
	}

	resp := make([]projectFileResponse, 0, len(projectFiles))
	for _, f := range projectFiles {
		batchStatus, ok := batchStatusByFileID[f.ID]
		resp = append(resp, projectFileResponse{
			ProjectFile: f,
			Status:      fileProcessingStatusFromBatchStatus(batchStatus, ok),
		})
	}

	return c.JSON(http.StatusOK, resp)
}

func fileProcessingStatusFromBatchStatus(batchStatus string, hasBatchStatus bool) string {
	if !hasBatchStatus {
		return "no_status"
	}

	switch batchStatus {
	case "completed":
		return "processed"
	case "failed":
		return "failed"
	default:
		return "processing"
	}
}

func GetTextUnitHandler(c echo.Context) error {
	type getTextUnitParams struct {
		ID string `param:"unit_id" validate:"required"`
	}

	type getTextUnitResponse struct {
		Message string         `json:"message"`
		Unit    *pgdb.TextUnit `json:"data,omitempty"`
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
	qtx := pgdb.New(conn)

	projectID, err := qtx.GetProjectIDFromTextUnit(ctx, params.ID)
	if err != nil {
		return c.JSON(http.StatusNotFound, getTextUnitResponse{
			Message: "Text unit not found",
		})
	}

	if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
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
	qtx := pgdb.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInProject(ctx, pgdb.IsUserInProjectParams{
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
