package base

import (
	"context"
	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"strconv"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"

	gonanoid "github.com/matoous/go-nanoid/v2"
)

func parseBaseFileID(fileID string) (int64, error) {
	baseID := fileID
	if before, _, ok := strings.Cut(fileID, "-sheet-"); ok {
		baseID = before
	}
	return strconv.ParseInt(baseID, 10, 64)
}

func (s *GraphDBStorage) AddUnit(ctx context.Context, qtx *db.Queries, unit *common.Unit) (int64, error) {
	uId, err := gonanoid.New()
	if err != nil {
		return -1, err
	}
	fId, err := parseBaseFileID(unit.FileID)
	if err != nil {
		return -1, err
	}
	s.dbLock.Lock()
	id, err := qtx.AddProjectFileTextUnit(ctx, db.AddProjectFileTextUnitParams{
		PublicID:      uId,
		ProjectFileID: fId,
		Text:          unit.Text,
	})
	s.dbLock.Unlock()
	if err != nil {
		return -1, err
	}

	return id, nil
}

// SaveUnits persists a batch of text units to the database within a single
// transaction. Text units represent chunks of source documents that are linked
// to entities and relationships through sources.
func (s *GraphDBStorage) SaveUnits(ctx context.Context, units []*common.Unit) ([]int64, error) {
	ids := make([]int64, 0, len(units))

	trx, err := s.conn.Begin(ctx)
	if err != nil {
		return nil, err
	}

	q := db.New(s.conn)
	qtx := q.WithTx(trx)

	for _, unit := range units {
		fId, err := parseBaseFileID(unit.FileID)
		if err != nil {
			return nil, err
		}

		id, err := qtx.AddProjectFileTextUnit(ctx, db.AddProjectFileTextUnitParams{
			PublicID:      unit.ID,
			ProjectFileID: fId,
			Text:          unit.Text,
		})
		if err != nil {
			return nil, err
		}

		ids = append(ids, id)
	}

	err = trx.Commit(ctx)
	if err != nil {
		return nil, err
	}

	return nil, nil
}
