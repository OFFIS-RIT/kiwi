package routes

import (
	"context"
	"database/sql"
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

func GetUserProjectsHandler(c echo.Context) error {
	type userProject struct {
		ProjectID                int64                   `json:"project_id"`
		ProjectName              string                  `json:"project_name"`
		ProjectState             string                  `json:"project_state"`
		Hidden                   bool                    `json:"hidden"`
		Type                     *string                 `json:"type,omitempty"`
		ProcessStep              *util.BatchStepProgress `json:"process_step,omitempty"`
		ProcessPercentage        *int32                  `json:"process_percentage,omitempty"`
		ProcessEstimatedDuration *int64                  `json:"process_estimated_duration,omitempty"`
		ProcessTimeRemaining     *int64                  `json:"process_time_remaining,omitempty"`
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	rows, err := q.GetUserProjects(ctx, sql.NullInt64{Int64: user.UserID, Valid: true})
	if err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}

	projects := make([]userProject, 0, len(rows))
	for _, row := range rows {
		project := userProject{
			ProjectID:    row.ProjectID,
			ProjectName:  row.ProjectName,
			ProjectState: row.ProjectState,
			Hidden:       row.Hidden,
		}

		if row.ProjectType != "" {
			projectType := row.ProjectType
			project.Type = &projectType
		}

		if row.ProjectState != "ready" {
			correlationID, err := q.GetLatestCorrelationForProject(ctx, row.ProjectID)
			if err == nil && correlationID != "" {
				progress, err := q.GetProjectFullProgress(ctx, correlationID)
				if err == nil {
					batchProgress := util.BuildBatchProgress(progress)
					if batchProgress.Step != nil {
						project.ProcessStep = batchProgress.Step
					}
					if batchProgress.Percentage != nil {
						project.ProcessPercentage = batchProgress.Percentage
					}
					if batchProgress.EstimatedDuration != nil {
						project.ProcessEstimatedDuration = batchProgress.EstimatedDuration
					}
					if batchProgress.TimeRemaining != nil {
						project.ProcessTimeRemaining = batchProgress.TimeRemaining
					}
				}
			}
		}

		projects = append(projects, project)
	}

	aiClient := c.(*middleware.AppContext).App.AiClient
	go func() {
		ctx := context.Background()
		_ = aiClient.LoadModel(ctx)
	}()

	return c.JSON(http.StatusOK, projects)
}
