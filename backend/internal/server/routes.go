package server

import (
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/server/routes"

	"github.com/labstack/echo/v4"
)

func RegisterRoutes(e *echo.Echo) {
	// Health check route
	e.GET("/health", func(c echo.Context) error {
		return c.String(200, "OK")
	})

	apiRoutes := e.Group("/api", middleware.AuthMiddleware)

	// Project routes
	apiRoutes.GET("/projects", routes.GetProjectsHandler)
	apiRoutes.POST("/projects", routes.CreateProjectHandler, middleware.RequirePermission("project.create"))
	apiRoutes.PATCH("/projects/:id", routes.EditProjectHandler, middleware.RequirePermission("project.update"))
	apiRoutes.DELETE("/projects/:id", routes.DeleteProjectHandler, middleware.RequirePermission("project.delete"))
	apiRoutes.GET("/user-projects", routes.GetUserProjectsHandler)
	apiRoutes.POST("/user-projects", routes.CreateUserProjectHandler)
	apiRoutes.DELETE("/user-projects/:id", routes.DeleteUserProjectHandler)
	apiRoutes.GET("/expert-projects", routes.GetExpertProjectsHandler, middleware.RequirePermission("project.view:all"))
	apiRoutes.POST("/expert-projects", routes.CreateExpertProjectHandler, middleware.RequirePermission("project.create"))
	apiRoutes.DELETE("/expert-projects/:id", routes.DeleteExpertProjectHandler, middleware.RequirePermission("project.delete"))

	// Text unit routes
	apiRoutes.GET("/projects/units/:unit_id", routes.GetTextUnitHandler)

	// Project file routes
	apiRoutes.GET("/projects/:id/files", routes.GetProjectFilesHandler, middleware.RequirePermission("project.list:file"))
	apiRoutes.POST("/projects/:id/files", routes.AddFilesToProjectHandler, middleware.RequirePermission("project.add:file"))
	apiRoutes.DELETE("/projects/:id/files", routes.DeleteFileFromProjectHandler, middleware.RequirePermission("project.delete:file"))
	apiRoutes.POST("/projects/:id/file", routes.GetProjectFile)

	// Project query routes
	apiRoutes.POST("/projects/:id/query", routes.QueryProjectHandler)
	apiRoutes.POST("/projects/:id/stream", routes.QueryProjectStreamHandler)
	apiRoutes.GET("/projects/:id/chats", routes.GetUserChatsHandler)
	apiRoutes.GET("/projects/:id/chats/:conversation_id", routes.GetChatHandler)
	apiRoutes.DELETE("/projects/:id/chats/:conversation_id", routes.DeleteChatHandler)

	// Group Routes
	apiRoutes.GET("/groups", routes.GetGroupsHandler, middleware.RequireAnyPermission("group.view", "group.view:all"))
	apiRoutes.POST("/groups", routes.CreateGroupHandler, middleware.RequirePermission("group.create"))
	apiRoutes.PATCH("/groups/:id", routes.EditGroupHandler, middleware.RequirePermission("group.update"))
	apiRoutes.DELETE("/groups/:id", routes.DeleteGroupHandler, middleware.RequirePermission("group.delete"))

	// Group user management routes
	apiRoutes.GET("/groups/:id/users", routes.GetGroupUsersHandler, middleware.RequirePermission("group.list:user"))
	apiRoutes.POST("/groups/:id/users", routes.AddUserToGroupHandler, middleware.RequirePermission("group.add:user"))
	apiRoutes.DELETE("/groups/:id/users", routes.DeleteUserFromGroupHandler, middleware.RequirePermission("group.remove:user"))
}
