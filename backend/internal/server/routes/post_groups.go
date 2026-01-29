package routes

import (
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"net/http"

	_ "github.com/go-playground/validator"
	"github.com/labstack/echo/v4"
)

// CreateGroupHandler creates a new group
func CreateGroupHandler(c echo.Context) error {
	type userInGroupBody struct {
		UserID int64  `json:"user_id" validate:"required,numeric"`
		Role   string `json:"role" validate:"required,oneof=admin user"`
	}

	type createGroupBody struct {
		Name  string            `json:"name" validate:"required"`
		Users []userInGroupBody `json:"users" validate:"required"`
	}

	type createGroupResponse struct {
		Message string            `json:"message"`
		Group   *pgdb.Group       `json:"group,omitempty"`
		Users   []*pgdb.GroupUser `json:"users,omitempty"`
	}

	data := new(createGroupBody)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, createGroupResponse{
			Message: "Invalid request body",
		})
	}

	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, createGroupResponse{
			Message: "Invalid request body",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, createGroupResponse{
			Message: "Unauthorized",
		})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, createGroupResponse{
			Message: "Internal server error",
		})
	}
	defer tx.Rollback(ctx)
	queries := pgdb.New(conn)
	qtx := queries.WithTx(tx)

	group, err := qtx.CreateGroup(ctx, data.Name)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, createGroupResponse{
			Message: "Internal server error",
		})
	}

	dbUsers := make([]*pgdb.GroupUser, 0)
	for _, user := range data.Users {
		dbUser, err := qtx.AddUserToGroup(ctx, pgdb.AddUserToGroupParams{
			GroupID: group.ID,
			UserID:  user.UserID,
			Role:    user.Role,
		})
		if err != nil {
			return c.JSON(http.StatusInternalServerError, createGroupResponse{
				Message: "Internal server error",
			})
		}
		dbUsers = append(dbUsers, &dbUser)
	}

	err = tx.Commit(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, createGroupResponse{
			Message: "Internal server error",
		})
	}

	return c.JSON(
		http.StatusOK,
		createGroupResponse{
			Message: "Group created successfully",
			Group:   &group,
			Users:   dbUsers,
		},
	)
}

// AddUserToGroupHandler adds a user to a group
func AddUserToGroupHandler(c echo.Context) error {
	type addUserToGroupParams struct {
		GroupID int64 `param:"id" validate:"required,numeric"`
	}

	type addUserToGroupBody struct {
		UserID int64  `json:"user_id" validate:"required,numeric"`
		Role   string `json:"role" validate:"required,oneof=admin user"`
	}

	type addUserToGroupResponse struct {
		Message string          `json:"message"`
		User    *pgdb.GroupUser `json:"user,omitempty"`
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, addUserToGroupResponse{
			Message: "Unauthorized",
		})
	}

	params := new(addUserToGroupParams)
	if err := c.Bind(params); err != nil {
		return c.JSON(http.StatusBadRequest, addUserToGroupResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(params); err != nil {
		return c.JSON(http.StatusBadRequest, addUserToGroupResponse{
			Message: "Invalid request params",
		})
	}

	data := new(addUserToGroupBody)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, addUserToGroupResponse{
			Message: "Invalid request body",
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, addUserToGroupResponse{
			Message: "Invalid request body",
		})
	}

	addUserParams := pgdb.AddUserToGroupParams{
		GroupID: params.GroupID,
		UserID:  data.UserID,
		Role:    data.Role,
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	q := pgdb.New(conn)

	if !middleware.IsAdmin(user) {
		count, err := q.IsUserInGroup(ctx, pgdb.IsUserInGroupParams{
			GroupID: addUserParams.GroupID,
			UserID:  user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, addUserToGroupResponse{
				Message: "You are not a member of this group",
			})
		}
	}

	count, err := q.IsUserInGroup(ctx, pgdb.IsUserInGroupParams{
		GroupID: addUserParams.GroupID,
		UserID:  addUserParams.UserID,
	})
	if err != nil {
		return c.JSON(http.StatusInternalServerError, addUserToGroupResponse{
			Message: "Internal server error",
		})
	}
	if count > 0 {
		return c.JSON(http.StatusBadRequest, addUserToGroupResponse{
			Message: "User is already a member of this group",
		})
	}

	dbUser, err := q.AddUserToGroup(ctx, addUserParams)
	if err != nil {
		return c.JSON(http.StatusBadRequest, addUserToGroupResponse{
			Message: "Internal server error",
		})
	}

	return c.JSON(http.StatusOK, addUserToGroupResponse{
		Message: "User added to group successfully",
		User:    &dbUser,
	})
}
