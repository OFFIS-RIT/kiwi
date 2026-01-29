package pgx

import (
	"context"
	"fmt"
	"strconv"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"

	"github.com/pgvector/pgvector-go"
)

func (s *GraphDBStorage) GetEntitiesByProjectID(
	ctx context.Context,
	qtx *pgdb.Queries,
	projectID int64,
) ([]int64, []common.Entity, error) {
	ents, err := qtx.GetProjectEntities(ctx, projectID)
	if err != nil {
		return nil, nil, err
	}

	ids := make([]int64, len(ents))
	entities := make([]common.Entity, len(ents))

	for idx := range ents {
		ent := ents[idx]
		ids[idx] = ent.ID
		entities[idx] = common.Entity{
			ID:          ent.PublicID,
			Name:        ent.Name,
			Description: ent.Description,
			Type:        ent.Type,
		}
	}

	return ids, entities, nil
}

func (s *GraphDBStorage) UpdateEntityByPublicID(
	ctx context.Context,
	qtx *pgdb.Queries,
	entity common.Entity,
) (int64, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(entity.Description))
	if err != nil {
		return -1, err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	defer s.dbLock.Unlock()
	return qtx.UpdateProjectEntity(ctx, pgdb.UpdateProjectEntityParams{
		PublicID:    entity.ID,
		Description: entity.Description,
		Embedding:   embed,
	})
}

func (s *GraphDBStorage) getSimilarEntityIdsByEmebedding(
	ctx context.Context,
	qtx *pgdb.Queries,
	projectId int64,
	embedding []float32,
	topk int32,
) ([]int64, error) {
	return qtx.FindSimilarEntities(ctx, pgdb.FindSimilarEntitiesParams{
		ProjectID: projectId,
		Embedding: pgvector.NewVector(embedding),
		Limit:     topk,
		Column4:   0.4,
	})
}

// SaveEntities persists a batch of entities and their sources to the database.
// It generates vector embeddings for each entity and source description to enable
// semantic similarity search.
func (s *GraphDBStorage) SaveEntities(ctx context.Context, entities []common.Entity, graphId string) ([]int64, error) {
	if len(entities) == 0 {
		return nil, nil
	}

	projectID, err := strconv.ParseInt(graphId, 10, 64)
	if err != nil {
		return nil, err
	}

	entityChunk := 250
	sourceChunk := 500

	ids := make([]int64, 0, len(entities))

	err = store.ChunkRange(len(entities), entityChunk, func(start, end int) error {
		merged := mergeEntitiesByPublicID(entities[start:end])
		if len(merged) == 0 {
			return nil
		}

		logger.Debug("[Graph][SaveEntities] Saving chunk", "entities", len(merged))

		tx, err := s.conn.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		qtx := pgdb.New(tx)

		entityInputs := make([][]byte, len(merged))
		for i := range merged {
			entityInputs[i] = []byte(merged[i].Description)
		}
		logger.Debug("[Graph][SaveEntities] Generating entity embeddings", "count", len(entityInputs))
		entityEmb, err := store.GenerateEmbeddings(ctx, s.aiClient, entityInputs)
		if err != nil {
			return err
		}

		entityPublicIDs := make([]string, 0, len(merged))
		names := make([]string, 0, len(merged))
		descriptions := make([]string, 0, len(merged))
		types := make([]string, 0, len(merged))
		embeddings := make([]pgvector.Vector, 0, len(merged))
		for i, e := range merged {
			if e.ID == "" {
				return fmt.Errorf("entity public_id is empty")
			}
			entityPublicIDs = append(entityPublicIDs, e.ID)
			names = append(names, e.Name)
			descriptions = append(descriptions, e.Description)
			types = append(types, e.Type)
			embeddings = append(embeddings, pgvector.NewVector(entityEmb[i]))
		}

		logger.Debug("[Graph][SaveEntities] Bulk upserting entities", "count", len(merged))
		rows, err := qtx.UpsertProjectEntities(ctx, pgdb.UpsertProjectEntitiesParams{
			ProjectID:    projectID,
			Names:        names,
			Descriptions: descriptions,
			Types:        types,
			Embeddings:   embeddings,
			PublicIds:    entityPublicIDs,
		})
		if err != nil {
			return err
		}

		entityIDByPublicID := make(map[string]int64, len(rows))
		for _, r := range rows {
			entityIDByPublicID[r.PublicID] = r.ID
			ids = append(ids, r.ID)
		}

		sources := flattenEntitySources(merged, entityIDByPublicID)
		if len(sources) > 0 {
			err = store.ChunkRange(len(sources), sourceChunk, func(sStart, sEnd int) error {
				part := sources[sStart:sEnd]
				logger.Debug("[Graph][SaveEntities] Saving entity sources chunk", "sources", len(part))

				unitPublicIDs := make([]string, 0, len(part))
				for _, src := range part {
					unitPublicIDs = append(unitPublicIDs, src.unitPublicID)
				}
				unitRows, err := qtx.GetTextUnitIDsByPublicIDs(ctx, store.DedupeStrings(unitPublicIDs))
				if err != nil {
					return err
				}
				unitIDByPublicID := make(map[string]int64, len(unitRows))
				for _, r := range unitRows {
					unitIDByPublicID[r.PublicID] = r.ID
				}

				inputs := make([][]byte, len(part))
				for i := range part {
					inputs[i] = []byte(part[i].description)
				}
				logger.Debug("[Graph][SaveEntities] Generating entity source embeddings", "count", len(inputs))
				embs, err := store.GenerateEmbeddings(ctx, s.aiClient, inputs)
				if err != nil {
					return err
				}

				sPublicIDs := make([]string, 0, len(part))
				sEntityIDs := make([]int64, 0, len(part))
				sUnitIDs := make([]int64, 0, len(part))
				sDescriptions := make([]string, 0, len(part))
				sEmbeddings := make([]pgvector.Vector, 0, len(part))
				for i := range part {
					unitID, ok := unitIDByPublicID[part[i].unitPublicID]
					if !ok {
						return fmt.Errorf("missing text unit for source: unit_public_id=%s", part[i].unitPublicID)
					}
					sPublicIDs = append(sPublicIDs, part[i].publicID)
					sEntityIDs = append(sEntityIDs, part[i].entityID)
					sUnitIDs = append(sUnitIDs, unitID)
					sDescriptions = append(sDescriptions, part[i].description)
					sEmbeddings = append(sEmbeddings, pgvector.NewVector(embs[i]))
				}

				logger.Debug("[Graph][SaveEntities] Bulk upserting entity sources", "count", len(part))
				return qtx.UpsertEntitySources(ctx, pgdb.UpsertEntitySourcesParams{
					EntityIds:    sEntityIDs,
					TextUnitIds:  sUnitIDs,
					Descriptions: sDescriptions,
					Embeddings:   sEmbeddings,
					PublicIds:    sPublicIDs,
				})
			})
			if err != nil {
				return err
			}
		}

		logger.Debug("[Graph][SaveEntities] Chunk committed", "entities", len(merged))
		return tx.Commit(ctx)
	})
	if err != nil {
		return nil, err
	}

	return ids, nil
}

type entitySourceRow struct {
	publicID     string
	entityID     int64
	unitPublicID string
	description  string
}

func mergeEntitiesByPublicID(in []common.Entity) []common.Entity {
	byID := make(map[string]int, len(in))
	out := make([]common.Entity, 0, len(in))
	for _, e := range in {
		if e.ID == "" {
			continue
		}
		if idx, ok := byID[e.ID]; ok {
			if e.Name != "" {
				out[idx].Name = e.Name
			}
			if e.Description != "" {
				out[idx].Description = e.Description
			}
			if e.Type != "" {
				out[idx].Type = e.Type
			}
			if len(e.Sources) > 0 {
				out[idx].Sources = append(out[idx].Sources, e.Sources...)
			}
			continue
		}
		byID[e.ID] = len(out)
		out = append(out, e)
	}
	return out
}

func flattenEntitySources(entities []common.Entity, entityIDByPublicID map[string]int64) []entitySourceRow {
	rows := make([]entitySourceRow, 0)
	indexByPublicID := make(map[string]int)

	for _, e := range entities {
		entityID, ok := entityIDByPublicID[e.ID]
		if !ok {
			continue
		}
		for _, src := range e.Sources {
			if src.ID == "" || src.Unit == nil || src.Unit.ID == "" {
				continue
			}
			row := entitySourceRow{
				publicID:     src.ID,
				entityID:     entityID,
				unitPublicID: src.Unit.ID,
				description:  src.Description,
			}
			if idx, ok := indexByPublicID[row.publicID]; ok {
				rows[idx] = row
				continue
			}
			indexByPublicID[row.publicID] = len(rows)
			rows = append(rows, row)
		}
	}

	return rows
}
