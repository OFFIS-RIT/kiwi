package timing

import (
	"context"
	"kiwi/internal/db"

	"github.com/jackc/pgx/v5/pgxpool"
)

func AddFileProcessingTime(
	ctx context.Context,
	id, amount int64,
	durationMs int64,
	statType string,
	conn *pgxpool.Pool,
) error {
	q := db.New(conn)

	return q.AddProcessTime(ctx, db.AddProcessTimeParams{
		ProjectID: id,
		Amount:    int32(amount),
		Duration:  durationMs,
		StatType:  statType,
	})
}

func PredictFileProcessingTime(ctx context.Context, amount int64, statType string, conn *pgxpool.Pool) (int64, error) {
	q := db.New(conn)

	return q.PredictProjectProcessTime(ctx, db.PredictProjectProcessTimeParams{
		Duration: amount,
		StatType: statType,
	})
}
