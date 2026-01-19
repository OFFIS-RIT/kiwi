package middleware

import (
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	"github.com/rabbitmq/amqp091-go"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	oai "github.com/OFFIS-RIT/kiwi/backend/pkg/ai/ollama"
	gai "github.com/OFFIS-RIT/kiwi/backend/pkg/ai/openai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

type AppUser struct {
	UserID      int32
	Role        string
	Permissions []string
}

type App struct {
	DBConn         *pgxpool.Pool
	Queue          *amqp091.Channel
	Key            *keyfunc.Keyfunc
	S3             *s3.Client
	AiClient       ai.GraphAIClient
	MasterAPIKey   string
	MasterUserID   int32
	MasterUserRole string
}

type AppContext struct {
	echo.Context
	App  *App
	User *AppUser
}

func AppContextMiddleware(
	db *pgxpool.Pool,
	queue *amqp091.Channel,
	key *keyfunc.Keyfunc,
	s3 *s3.Client,
	masterAPIKey string,
	masterUserID int32,
	masterUserRole string,
) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			adapter := util.GetEnv("AI_ADAPTER")
			var aiClient ai.GraphAIClient

			switch adapter {
			case "ollama":
				client, err := oai.NewGraphOllamaClient(oai.NewGraphOllamaClientParams{
					EmbeddingModel:   util.GetEnv("AI_EMBED_MODEL"),
					DescriptionModel: util.GetEnv("AI_CHAT_DESCRIBE_MODEL"),
					ExtractionModel:  util.GetEnv("AI_CHAT_EXTRACT_MODEL"),
					ImageModel:       util.GetEnv("AI_IMAGE_MODEL"),

					BaseURL: util.GetEnv("AI_CHAT_URL"),
					ApiKey:  util.GetEnv("AI_CHAT_KEY"),

					MaxConcurrentRequests: int64(util.GetEnvNumeric("AI_PARALLEL_REQ", 15)),
				})
				if err != nil {
					logger.Fatal("Failed to create Ollama client", "err", err)
				}
				aiClient = client
			default:
				aiClient = gai.NewGraphOpenAIClient(gai.NewGraphOpenAIClientParams{
					EmbeddingModel:   util.GetEnv("AI_EMBED_MODEL"),
					DescriptionModel: util.GetEnv("AI_CHAT_DESCRIBE_MODEL"),
					ExtractionModel:  util.GetEnv("AI_CHAT_EXTRACT_MODEL"),
					ImageModel:       util.GetEnv("AI_IMAGE_MODEL"),

					EmbeddingURL: util.GetEnv("AI_EMBED_URL"),
					EmbeddingKey: util.GetEnv("AI_EMBED_KEY"),
					ChatURL:      util.GetEnv("AI_CHAT_URL"),
					ChatKey:      util.GetEnv("AI_CHAT_KEY"),
					ImageURL:     util.GetEnv("AI_IMAGE_URL"),
					ImageKey:     util.GetEnv("AI_IMAGE_KEY"),

					MaxConcurrentRequests: int64(util.GetEnvNumeric("AI_PARALLEL_REQ", 15)),
				})
			}

			app := &App{
				DBConn:         db,
				Queue:          queue,
				Key:            key,
				S3:             s3,
				AiClient:       aiClient,
				MasterAPIKey:   masterAPIKey,
				MasterUserID:   masterUserID,
				MasterUserRole: masterUserRole,
			}
			cc := &AppContext{c, app, nil}
			return next(cc)
		}
	}
}
