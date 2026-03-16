package pgx

import (
	"context"
	"fmt"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"

	"github.com/pgvector/pgvector-go"
)

func (s *GraphDBStorage) GetEntitiesByProjectID(
	ctx context.Context,
	qtx *pgdb.Queries,
	projectID string,
) ([]string, []common.Entity, error) {
	ents, err := qtx.GetProjectEntities(ctx, projectID)
	if err != nil {
		return nil, nil, err
	}

	ids := make([]string, len(ents))
	entities := make([]common.Entity, len(ents))

	for idx := range ents {
		ent := ents[idx]
		ids[idx] = ent.ID
		entities[idx] = common.Entity{
			ID:          ent.ID,
			Name:        ent.Name,
			Description: ent.Description,
			Type:        ent.Type,
		}
	}

	return ids, entities, nil
}

func (s *GraphDBStorage) UpdateEntityByID(
	ctx context.Context,
	qtx *pgdb.Queries,
	entity common.Entity,
) (string, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(entity.Description))
	if err != nil {
		return "", err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	defer s.dbLock.Unlock()
	return qtx.UpdateProjectEntity(ctx, pgdb.UpdateProjectEntityParams{
		ID:          entity.ID,
		Description: entity.Description,
		Embedding:   embed,
	})
}

func (s *GraphDBStorage) getSimilarEntityIdsByEmebedding(
	ctx context.Context,
	qtx *pgdb.Queries,
	projectId string,
	embedding []float32,
	topk int32,
) ([]string, error) {
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
func (s *GraphDBStorage) SaveEntities(ctx context.Context, entities []common.Entity, graphId string) ([]string, error) {
	if len(entities) == 0 {
		return nil, nil
	}

	entityChunk := 250
	sourceChunk := 500

	ids := make([]string, 0, len(entities))
	projectID := graphId

	err := store.ChunkRange(len(entities), entityChunk, func(start, end int) error {
		merged := mergeEntitiesByID(entities[start:end])
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

		entityIDs := make([]string, 0, len(merged))
		names := make([]string, 0, len(merged))
		descriptions := make([]string, 0, len(merged))
		types := make([]string, 0, len(merged))
		embeddings := make([]pgvector.Vector, 0, len(merged))
		for i, e := range merged {
			if e.ID == "" {
				return fmt.Errorf("entity id is empty")
			}
			entityIDs = append(entityIDs, e.ID)
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
			Ids:          entityIDs,
		})
		if err != nil {
			return err
		}

		ids = append(ids, rows...)

		sources := flattenEntitySources(merged)
		if len(sources) > 0 {
			err = store.ChunkRange(len(sources), sourceChunk, func(sStart, sEnd int) error {
				part := sources[sStart:sEnd]
				logger.Debug("[Graph][SaveEntities] Saving entity sources chunk", "sources", len(part))

				inputs := make([][]byte, len(part))
				for i := range part {
					inputs[i] = []byte(part[i].description)
				}
				logger.Debug("[Graph][SaveEntities] Generating entity source embeddings", "count", len(inputs))
				embs, err := store.GenerateEmbeddings(ctx, s.aiClient, inputs)
				if err != nil {
					return err
				}

				sIDs := make([]string, 0, len(part))
				sEntityIDs := make([]string, 0, len(part))
				sUnitIDs := make([]string, 0, len(part))
				sDescriptions := make([]string, 0, len(part))
				sEmbeddings := make([]pgvector.Vector, 0, len(part))
				for i := range part {
					if part[i].unitID == "" {
						return fmt.Errorf("missing text unit for source: source_id=%s", part[i].id)
					}
					sIDs = append(sIDs, part[i].id)
					sEntityIDs = append(sEntityIDs, part[i].entityID)
					sUnitIDs = append(sUnitIDs, part[i].unitID)
					sDescriptions = append(sDescriptions, part[i].description)
					sEmbeddings = append(sEmbeddings, pgvector.NewVector(embs[i]))
				}

				logger.Debug("[Graph][SaveEntities] Bulk upserting entity sources", "count", len(part))
				return qtx.UpsertEntitySources(ctx, pgdb.UpsertEntitySourcesParams{
					Ids:          sIDs,
					EntityIds:    sEntityIDs,
					TextUnitIds:  sUnitIDs,
					Descriptions: sDescriptions,
					Embeddings:   sEmbeddings,
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
	id          string
	entityID    string
	unitID      string
	description string
}

func mergeEntitiesByID(in []common.Entity) []common.Entity {
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

func flattenEntitySources(entities []common.Entity) []entitySourceRow {
	rows := make([]entitySourceRow, 0)
	indexByID := make(map[string]int)

	for _, e := range entities {
		if e.ID == "" {
			continue
		}
		for _, src := range e.Sources {
			if src.ID == "" || src.Unit == nil || src.Unit.ID == "" {
				continue
			}
			row := entitySourceRow{
				id:          src.ID,
				entityID:    e.ID,
				unitID:      src.Unit.ID,
				description: src.Description,
			}
			if idx, ok := indexByID[row.id]; ok {
				rows[idx] = row
				continue
			}
			indexByID[row.id] = len(rows)
			rows = append(rows, row)
		}
	}

	return rows
}
