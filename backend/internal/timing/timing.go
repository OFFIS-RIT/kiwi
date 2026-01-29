package timing

import (
	"context"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"

	"github.com/jackc/pgx/v5/pgxpool"
)

func AddFileProcessingTime(
	ctx context.Context,
	id, amount int64,
	durationMs int64,
	statType string,
	conn *pgxpool.Pool,
) error {
	q := pgdb.New(conn)

	return q.AddProcessTime(ctx, pgdb.AddProcessTimeParams{
		ProjectID: id,
		Amount:    int32(amount),
		Duration:  durationMs,
		StatType:  statType,
	})
}

func PredictFileProcessingTime(ctx context.Context, amount int64, statType string, conn *pgxpool.Pool) (int64, error) {
	q := pgdb.New(conn)

	return q.PredictProjectProcessTime(ctx, pgdb.PredictProjectProcessTimeParams{
		Duration: amount,
		StatType: statType,
	})
}
