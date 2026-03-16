package workflow

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/OFFIS-RIT/kiwi/backend/internal/aiclient"
	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pgxvec "github.com/pgvector/pgvector-go/pgx"
)

func Init() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pgCfg, err := pgxpool.ParseConfig(util.GetEnv("DATABASE_URL"))
	if err != nil {
		logger.Fatal("Failed to parse database config", "err", err)
	}
	pgCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		return pgxvec.RegisterTypes(ctx, conn)
	}

	conn, err := pgxpool.NewWithConfig(ctx, pgCfg)
	if err != nil {
		logger.Fatal("Failed to connect to database", "err", err)
	}
	defer conn.Close()

	s3Client := storage.NewS3Client(ctx)
	timeoutMin := int(util.GetEnvNumeric("AI_TIMEOUT", 10))
	aiClient := aiclient.NewExtract(timeoutMin)

	service, err := NewService(ctx, conn, s3Client, aiClient)
	if err != nil {
		logger.Fatal("Failed to initialize workflow service", "err", err)
	}

	if err := service.Start(ctx); err != nil {
		logger.Error("Workflow worker stopped with error", "err", err)
	}
}
