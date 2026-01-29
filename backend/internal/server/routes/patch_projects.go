package routes

import (
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"net/http"

	"github.com/labstack/echo/v4"
)

func EditProjectHandler(c echo.Context) error {
	type editProjectData struct {
		ID   int64  `param:"id" validate:"required,numeric"`
		Name string `json:"name" validate:"required"`
	}

	type editProjectResponse struct {
		Message string        `json:"message"`
		Project *pgdb.Project `json:"project,omitempty"`
	}

	data := new(editProjectData)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, editProjectResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, editProjectResponse{
			Message: "Invalid request params",
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
			ID:     data.ID,
			UserID: user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, editProjectResponse{
				Message: "You are not a member of this project",
			})
		}
	}

	project, err := q.UpdateProject(ctx, pgdb.UpdateProjectParams{
		ID:   data.ID,
		Name: data.Name,
	})
	if err != nil {
		return c.JSON(http.StatusBadRequest, editProjectResponse{
			Message: "Internal server error",
		})
	}

	return c.JSON(http.StatusOK, editProjectResponse{
		Message: "Project updated successfully",
		Project: &project,
	})
}
