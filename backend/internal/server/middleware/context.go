package middleware

import (
	"github.com/OFFIS-RIT/kiwi/backend/internal/aiclient"
	workflowservice "github.com/OFFIS-RIT/kiwi/backend/internal/workflow"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
)

type AppUser struct {
	UserID      string
	Role        string
	Permissions []string
}

type App struct {
	DBConn         *pgxpool.Pool
	Key            *keyfunc.Keyfunc
	S3             *s3.Client
	AiClient       ai.GraphAIClient
	Workflows      *workflowservice.Service
	MasterAPIKey   string
	MasterUserID   string
	MasterUserRole string
}

type AppContext struct {
	echo.Context
	App  *App
	User *AppUser
}

func AppContextMiddleware(
	db *pgxpool.Pool,
	key *keyfunc.Keyfunc,
	s3 *s3.Client,
	workflows *workflowservice.Service,
	masterAPIKey string,
	masterUserID string,
	masterUserRole string,
	timeoutMin int,
) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			aiClient := aiclient.NewChat(timeoutMin)

			app := &App{
				DBConn:         db,
				Key:            key,
				S3:             s3,
				AiClient:       aiClient,
				Workflows:      workflows,
				MasterAPIKey:   masterAPIKey,
				MasterUserID:   masterUserID,
				MasterUserRole: masterUserRole,
			}
			cc := &AppContext{c, app, nil}
			return next(cc)
		}
	}
}
