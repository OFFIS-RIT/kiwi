package pgx

import (
	"context"
	"strconv"
	"strings"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"
)

func parseBaseFileID(fileID string) (int64, error) {
	baseID := fileID
	if before, _, ok := strings.Cut(fileID, "-sheet-"); ok {
		baseID = before
	}
	return strconv.ParseInt(baseID, 10, 64)
}

// SaveUnits persists a batch of text units to the database within a single
// transaction. Text units represent chunks of source documents that are linked
// to entities and relationships through sources.
func (s *GraphDBStorage) SaveUnits(ctx context.Context, units []*common.Unit) ([]int64, error) {
	if len(units) == 0 {
		return nil, nil
	}

	logger.Debug("[Graph][SaveUnits] Bulk upserting text units", "units", len(units))

	ids := make([]int64, 0, len(units))
	chunkSize := 1000
	err := store.ChunkRange(len(units), chunkSize, func(start, end int) error {
		tx, err := s.conn.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		qtx := pgdb.New(tx)

		count := end - start
		publicIDs := make([]string, 0, count)
		fileIDs := make([]int64, 0, count)
		texts := make([]string, 0, count)
		for _, unit := range units[start:end] {
			fId, err := parseBaseFileID(unit.FileID)
			if err != nil {
				return err
			}
			publicIDs = append(publicIDs, unit.ID)
			fileIDs = append(fileIDs, fId)
			texts = append(texts, unit.Text)
		}

		chunkIDs, err := qtx.UpsertTextUnits(ctx, pgdb.UpsertTextUnitsParams{
			PublicIds:      publicIDs,
			ProjectFileIds: fileIDs,
			Texts:          texts,
		})
		if err != nil {
			return err
		}
		ids = append(ids, chunkIDs...)

		return tx.Commit(ctx)
	})
	if err != nil {
		return nil, err
	}

	logger.Debug("[Graph][SaveUnits] Bulk upsert completed", "units", len(units), "chunks", (len(units)+chunkSize-1)/chunkSize)
	return ids, nil
}
