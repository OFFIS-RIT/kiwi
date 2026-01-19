package server

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/queue"
	mid "github.com/OFFIS-RIT/kiwi/backend/internal/server/middleware"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/go-playground/validator"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"

	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	pgxvec "github.com/pgvector/pgvector-go/pgx"
)

type CustomValidator struct {
	validator *validator.Validate
}

func (cv *CustomValidator) Validate(i any) error {
	if err := cv.validator.Struct(i); err != nil {
		return err
	}
	return nil
}

func Init() {
	e := echo.New()
	e.Validator = &CustomValidator{validator: validator.New()}

	jwksUrl := util.GetEnv("AUTH_URL") + "/jwks"
	k, err := keyfunc.NewDefault([]string{jwksUrl})
	if err != nil {
		logger.Fatal("Failed to load jwks keys", "err", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	conn, err := pgxpool.New(ctx, util.GetEnv("DATABASE_URL"))
	if err != nil {
		logger.Fatal("Failed to connect to database", "err", err)
	}
	defer conn.Close()
	conn.Config().AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		return pgxvec.RegisterTypes(ctx, conn)
	}

	que := queue.Init()
	defer que.Close()
	ch, err := que.Channel()
	if err != nil {
		logger.Fatal("Failed to open channel", "err", err)
	}

	queues := []string{"index_queue", "update_queue", "delete_queue", "preprocess_queue"}
	err = queue.SetupQueues(ch, queues)

	s3 := storage.NewS3Client(ctx)

	masterAPIKey := util.GetEnv("MASTER_API_KEY")
	parsedMasterUserID, _ := strconv.ParseInt(util.GetEnv("MASTER_USER_ID"), 10, 32)
	masterUserRole := util.GetEnv("MASTER_USER_ROLE")
	masterUserID := int32(parsedMasterUserID)

	e.Use(mid.AppContextMiddleware(conn, ch, &k, s3, masterAPIKey, masterUserID, masterUserRole))
	e.Use(middleware.CORS())
	e.Use(middleware.RequestLogger())
	e.Use(middleware.Recover())
	e.Use(middleware.BodyLimit("4G"))

	RegisterRoutes(e)

	go func() {
		port := util.GetEnv("PORT")
		if port == "" {
			port = "8080"
		}
		logger.Info("Starting server", "port", port)
		if err := e.Start(":" + port); err != nil && err != http.ErrServerClosed {
			logger.Fatal("Failed shutting down server", "err", err)
		}
	}()

	<-ctx.Done()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := e.Shutdown(ctx); err != nil {
		logger.Error("Failed to shutdown server", "err", err)
	}
}
