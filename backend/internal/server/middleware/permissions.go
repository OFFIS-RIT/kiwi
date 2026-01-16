package middleware

import (
	"net/http"
	"slices"

	"github.com/labstack/echo/v4"
)

func HasPermission(user *AppUser, permission string) bool {
	if user == nil {
		return false
	}
	return slices.Contains(user.Permissions, permission)
}

func HasAnyPermission(user *AppUser, permissions ...string) bool {
	if user == nil {
		return false
	}
	for _, permission := range permissions {
		if HasPermission(user, permission) {
			return true
		}
	}
	return false
}

func IsAdmin(user *AppUser) bool {
	if user == nil {
		return false
	}
	return user.Role == "admin"
}

func RequirePermission(permission string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			user := c.(*AppContext).User
			if user == nil {
				return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
			}

			if !HasPermission(user, permission) {
				return c.JSON(http.StatusForbidden, map[string]string{"error": "Forbidden: missing permission " + permission})
			}

			return next(c)
		}
	}
}

func RequireAnyPermission(permissions ...string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			user := c.(*AppContext).User
			if user == nil {
				return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
			}

			if !HasAnyPermission(user, permissions...) {
				return c.JSON(http.StatusForbidden, map[string]string{"error": "Forbidden: missing required permission"})
			}

			return next(c)
		}
	}
}
