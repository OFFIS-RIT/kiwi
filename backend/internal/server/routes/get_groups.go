package routes

import (
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"net/http"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"
)

func GetGroupsHandler(c echo.Context) error {
	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)
	ctx := c.Request().Context()

	if middleware.HasPermission(user, "group.view:all") {
		res, err := q.GetAllGroups(ctx)
		if err != nil {
			return c.String(http.StatusInternalServerError, err.Error())
		}
		return c.JSON(http.StatusOK, res)
	}

	userID := int64(user.UserID)

	res, err := q.GetGroupsForUser(ctx, userID)
	if err != nil {
		return c.String(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, res)
}

func GetGroupUsersHandler(c echo.Context) error {
	type getGroupUsersParams struct {
		GroupID int64 `param:"id" validate:"required,numeric"`
	}

	params := new(getGroupUsersParams)
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
		count, err := q.IsUserInGroup(ctx, pgdb.IsUserInGroupParams{
			GroupID: params.GroupID,
			UserID:  user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, map[string]string{"error": "You are not a member of this group"})
		}
	}

	users, err := q.GetGroupUsers(ctx, params.GroupID)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "Internal server error"})
	}

	return c.JSON(http.StatusOK, users)
}
