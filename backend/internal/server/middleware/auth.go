package middleware

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
)

var allPermissions = []string{
	"group.create",
	"group.update",
	"group.delete",
	"group.view:all",
	"group.view",
	"group.add:user",
	"group.remove:user",
	"group.list:user",
	"project.create",
	"project.update",
	"project.delete",
	"project.view:all",
	"project.add:file",
	"project.delete:file",
	"project.list:file",
}

func AuthMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		authHeader := c.Request().Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		}

		token := strings.Split(authHeader, " ")[1]
		app := c.(*AppContext).App

		// Master API Key bypass
		if app.MasterAPIKey != "" && app.MasterUserID != 0 && app.MasterUserRole != "" && token == app.MasterAPIKey {
			c.(*AppContext).User = &AppUser{
				UserID:      app.MasterUserID,
				Role:        app.MasterUserRole,
				Permissions: allPermissions,
			}
			return next(c)
		}

		// Parse JWT token
		k := *c.(*AppContext).App.Key
		parsed, err := jwt.Parse(token, k.Keyfunc)
		if err != nil || !parsed.Valid {
			return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		}

		claims, ok := parsed.Claims.(jwt.MapClaims)
		if !ok {
			return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		}

		var userID int64
		if idClaim, ok := claims["id"].(string); ok {
			userID, err = strconv.ParseInt(idClaim, 10, 64)
			if err != nil {
				return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Invalid user ID"})
			}
		} else if idFloat, ok := claims["id"].(float64); ok {
			userID = int64(idFloat)
		} else {
			return c.JSON(http.StatusUnauthorized, map[string]string{"error": "Invalid user ID"})
		}

		role := "user"
		if roleClaim, ok := claims["role"].(string); ok {
			role = roleClaim
		}

		var permissions []string
		if permsClaim, ok := claims["permissions"].([]any); ok {
			for _, p := range permsClaim {
				if pStr, ok := p.(string); ok {
					permissions = append(permissions, pStr)
				}
			}
		}

		if role == "admin" && len(permissions) == 0 {
			permissions = allPermissions
		}

		c.(*AppContext).User = &AppUser{
			UserID:      userID,
			Role:        role,
			Permissions: permissions,
		}

		return next(c)
	}
}
