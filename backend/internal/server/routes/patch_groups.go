package routes

import (
	"kiwi/internal/db"
	"kiwi/internal/server/middleware"
	"net/http"

	"github.com/labstack/echo/v4"
)

// EditGroupHandler updates a group
func EditGroupHandler(c echo.Context) error {
	type editGroupUser struct {
		UserID int64  `json:"user_id" validate:"numeric"`
		Role   string `json:"role" validate:"oneof=admin user"`
	}

	type editGroupData struct {
		GroupID int64            `param:"id" validate:"required,numeric"`
		Name    *string          `json:"name"`
		Users   []*editGroupUser `json:"users"`
	}

	type editGroupResponse struct {
		Message string          `json:"message"`
		Group   *db.Group       `json:"group,omitempty"`
		Users   *[]db.GroupUser `json:"users,omitempty"`
	}

	data := new(editGroupData)
	if err := c.Bind(data); err != nil {
		return c.JSON(http.StatusBadRequest, editGroupResponse{
			Message: "Invalid request params",
		})
	}
	if err := c.Validate(data); err != nil {
		return c.JSON(http.StatusBadRequest, editGroupResponse{
			Message: "Invalid request params",
		})
	}

	user := c.(*middleware.AppContext).User
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
	}

	ctx := c.Request().Context()
	conn := c.(*middleware.AppContext).App.DBConn
	tx, err := conn.Begin(ctx)
	if err != nil {
		return c.JSON(http.StatusBadRequest, editGroupResponse{
			Message: "Internal server error",
		})
	}
	defer tx.Rollback(ctx)
	queries := db.New(conn)
	qtx := queries.WithTx(tx)

	if !middleware.IsAdmin(user) {
		count, err := qtx.IsUserInGroup(ctx, db.IsUserInGroupParams{
			GroupID: data.GroupID,
			UserID:  user.UserID,
		})
		if err != nil || count == 0 {
			return c.JSON(http.StatusForbidden, editGroupResponse{
				Message: "You are not a member of this group",
			})
		}
	}

	group, err := qtx.GetGroup(ctx, data.GroupID)
	if err != nil {
		return c.JSON(http.StatusBadRequest, editGroupResponse{
			Message: "Internal server error",
		})
	}
	if data.Name != nil {
		g, err := qtx.UpdateGroup(ctx, db.UpdateGroupParams{
			ID:   data.GroupID,
			Name: *data.Name,
		})
		if err != nil {
			return c.JSON(http.StatusBadRequest, editGroupResponse{
				Message: "Internal server error",
			})
		}
		group = g
	}
	dbUsers, err := qtx.GetGroupUsers(ctx, data.GroupID)
	if data.Users != nil || len(data.Users) > 0 {
		for _, user := range data.Users {
			for _, dbUser := range dbUsers {
				if dbUser.UserID == user.UserID {
					continue
				}
			}

			dbUser, err := qtx.AddUserToGroup(ctx, db.AddUserToGroupParams{
				GroupID: group.ID,
				UserID:  user.UserID,
				Role:    user.Role,
			})
			if err != nil {
				return c.JSON(http.StatusBadRequest, editGroupResponse{
					Message: "Internal server error",
				})
			}
			dbUsers = append(dbUsers, dbUser)
		}
	}

	err = tx.Commit(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, editGroupResponse{
			Message: "Internal server error",
		})
	}

	return c.JSON(200, editGroupResponse{
		Message: "Group updated successfully",
		Group:   &group,
		Users:   &dbUsers,
	})
}
