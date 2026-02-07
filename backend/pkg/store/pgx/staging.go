package pgx

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"
)

const stagedInsertChunkSize = 1000

func (s *GraphDBStorage) insertStagedDataBatch(
	ctx context.Context,
	correlationID string,
	batchID int,
	projectID int64,
	dataType string,
	datas []string,
) error {
	if len(datas) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	return store.ChunkRange(len(datas), stagedInsertChunkSize, func(start, end int) error {
		if err := q.InsertStagedDataBatch(ctx, pgdb.InsertStagedDataBatchParams{
			CorrelationID: correlationID,
			BatchID:       int32(batchID),
			ProjectID:     projectID,
			DataType:      dataType,
			Datas:         datas[start:end],
		}); err != nil {
			return fmt.Errorf("failed to insert staged %s batch: %w", dataType, err)
		}

		return nil
	})
}

// StageUnits saves units to the staging table for later merging.
// This allows workers to extract in parallel without holding the project lock.
func (s *GraphDBStorage) StageUnits(
	ctx context.Context,
	correlationID string,
	batchID int,
	projectID int64,
	units []*common.Unit,
) error {
	datas := make([]string, 0, len(units))

	for _, unit := range units {
		data, err := json.Marshal(unit)
		if err != nil {
			return fmt.Errorf("failed to marshal unit: %w", err)
		}
		datas = append(datas, string(data))
	}

	return s.insertStagedDataBatch(ctx, correlationID, batchID, projectID, "unit", datas)
}

// StageEntities saves entities to the staging table for later merging.
func (s *GraphDBStorage) StageEntities(
	ctx context.Context,
	correlationID string,
	batchID int,
	projectID int64,
	entities []common.Entity,
) error {
	datas := make([]string, 0, len(entities))

	for _, entity := range entities {
		data, err := json.Marshal(entity)
		if err != nil {
			return fmt.Errorf("failed to marshal entity: %w", err)
		}
		datas = append(datas, string(data))
	}

	return s.insertStagedDataBatch(ctx, correlationID, batchID, projectID, "entity", datas)
}

// StageRelationships saves relationships to the staging table for later merging.
func (s *GraphDBStorage) StageRelationships(
	ctx context.Context,
	correlationID string,
	batchID int,
	projectID int64,
	relations []common.Relationship,
) error {
	datas := make([]string, 0, len(relations))

	for _, rel := range relations {
		data, err := json.Marshal(rel)
		if err != nil {
			return fmt.Errorf("failed to marshal relationship: %w", err)
		}
		datas = append(datas, string(data))
	}

	return s.insertStagedDataBatch(ctx, correlationID, batchID, projectID, "relationship", datas)
}

// GetStagedUnits retrieves units from the staging table.
func (s *GraphDBStorage) GetStagedUnits(
	ctx context.Context,
	correlationID string,
	batchID int,
) ([]*common.Unit, error) {
	q := pgdb.New(s.conn)

	rows, err := q.GetStagedUnits(ctx, pgdb.GetStagedUnitsParams{
		CorrelationID: correlationID,
		BatchID:       int32(batchID),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get staged units: %w", err)
	}

	units := make([]*common.Unit, 0, len(rows))
	for _, data := range rows {
		var unit common.Unit
		if err := json.Unmarshal(data, &unit); err != nil {
			return nil, fmt.Errorf("failed to unmarshal unit: %w", err)
		}
		units = append(units, &unit)
	}

	return units, nil
}

// GetStagedEntities retrieves entities from the staging table.
func (s *GraphDBStorage) GetStagedEntities(
	ctx context.Context,
	correlationID string,
	batchID int,
) ([]common.Entity, error) {
	q := pgdb.New(s.conn)

	rows, err := q.GetStagedEntities(ctx, pgdb.GetStagedEntitiesParams{
		CorrelationID: correlationID,
		BatchID:       int32(batchID),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get staged entities: %w", err)
	}

	entities := make([]common.Entity, 0, len(rows))
	for _, data := range rows {
		var entity common.Entity
		if err := json.Unmarshal(data, &entity); err != nil {
			return nil, fmt.Errorf("failed to unmarshal entity: %w", err)
		}
		entities = append(entities, entity)
	}

	return entities, nil
}

// GetStagedRelationships retrieves relationships from the staging table.
func (s *GraphDBStorage) GetStagedRelationships(
	ctx context.Context,
	correlationID string,
	batchID int,
) ([]common.Relationship, error) {
	q := pgdb.New(s.conn)

	rows, err := q.GetStagedRelationships(ctx, pgdb.GetStagedRelationshipsParams{
		CorrelationID: correlationID,
		BatchID:       int32(batchID),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get staged relationships: %w", err)
	}

	relations := make([]common.Relationship, 0, len(rows))
	for _, data := range rows {
		var rel common.Relationship
		if err := json.Unmarshal(data, &rel); err != nil {
			return nil, fmt.Errorf("failed to unmarshal relationship: %w", err)
		}
		relations = append(relations, rel)
	}

	return relations, nil
}

// DeleteStagedData removes staged data for a specific worker batch.
func (s *GraphDBStorage) DeleteStagedData(
	ctx context.Context,
	correlationID string,
	batchID int,
) error {
	q := pgdb.New(s.conn)

	err := q.DeleteStagedData(ctx, pgdb.DeleteStagedDataParams{
		CorrelationID: correlationID,
		BatchID:       int32(batchID),
	})
	if err != nil {
		return fmt.Errorf("failed to delete staged data: %w", err)
	}

	return nil
}
