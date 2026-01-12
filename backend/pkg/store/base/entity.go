package base

import (
	"context"
	"kiwi/internal/db"
	"strconv"

	"kiwi/pkg/common"

	"github.com/pgvector/pgvector-go"
	"golang.org/x/sync/errgroup"
)

func (s *GraphDBStorage) AddEntity(ctx context.Context, qtx *db.Queries, entity *common.Entity, projectId int64) (int64, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(entity.Description))
	if err != nil {
		return -1, err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	id, err := qtx.AddProjectEntity(ctx, db.AddProjectEntityParams{
		PublicID:    entity.ID,
		ProjectID:   projectId,
		Name:        entity.Name,
		Description: entity.Description,
		Type:        entity.Type,
		Embedding:   embed,
	})
	s.dbLock.Unlock()
	if err != nil {
		return -1, err
	}

	return id, nil
}

func (s *GraphDBStorage) AddEntitySource(
	ctx context.Context,
	qtx *db.Queries,
	source *common.Source,
	entityId int64,
	textUnitId int64,
) (int64, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(source.Description))
	if err != nil {
		return -1, err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	id, err := qtx.AddProjectEntitySource(ctx, db.AddProjectEntitySourceParams{
		PublicID:    source.ID,
		EntityID:    entityId,
		TextUnitID:  textUnitId,
		Description: source.Description,
		Embedding:   embed,
	})
	s.dbLock.Unlock()
	if err != nil {
		return -1, err
	}

	return id, nil
}

func (s *GraphDBStorage) GetEntitiesByProjectID(
	ctx context.Context,
	qtx *db.Queries,
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
	qtx *db.Queries,
	entity common.Entity,
) (int64, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(entity.Description))
	if err != nil {
		return -1, err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	defer s.dbLock.Unlock()
	return qtx.UpdateProjectEntity(ctx, db.UpdateProjectEntityParams{
		PublicID:    entity.ID,
		Description: entity.Description,
		Embedding:   embed,
	})
}

func (s *GraphDBStorage) getSimilarEntityIdsByEmebedding(
	ctx context.Context,
	qtx *db.Queries,
	projectId int64,
	embedding []float32,
	topk int32,
) ([]int64, error) {
	return qtx.FindSimilarEntities(ctx, db.FindSimilarEntitiesParams{
		ProjectID: projectId,
		Embedding: pgvector.NewVector(embedding),
		Limit:     topk,
		Column4:   0.4,
	})
}

// SaveEntities persists a batch of entities and their sources to the database.
// It generates vector embeddings for each entity and source description to enable
// semantic similarity search. All operations are wrapped in a single transaction.
func (s *GraphDBStorage) SaveEntities(ctx context.Context, entities []common.Entity, graphId string) ([]int64, error) {
	ids := make([]int64, 0, len(entities))

	trx, err := s.conn.Begin(ctx)
	if err != nil {
		return nil, err
	}

	q := db.New(s.conn)
	qtx := q.WithTx(trx)

	for _, entity := range entities {
		embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(entity.Description))
		if err != nil {
			return nil, err
		}
		embed := pgvector.NewVector(embedding)

		gId, err := strconv.ParseInt(graphId, 10, 64)
		if err != nil {
			return nil, err
		}

		id, err := qtx.AddProjectEntity(ctx, db.AddProjectEntityParams{
			PublicID:    entity.ID,
			ProjectID:   gId,
			Name:        entity.Name,
			Description: entity.Description,
			Type:        entity.Type,
			Embedding:   embed,
		})
		if err != nil {
			return nil, err
		}

		eg, gCtx := errgroup.WithContext(ctx)
		eg.SetLimit(s.maxParallel)

		for _, source := range entity.Sources {
			src := source

			eg.Go(func() error {
				embedding, err := s.aiClient.GenerateEmbedding(gCtx, []byte(src.Description))
				if err != nil {
					return err
				}
				embed := pgvector.NewVector(embedding)

				s.dbLock.Lock()
				defer s.dbLock.Unlock()
				unit, err := qtx.GetTextUnitByPublicId(gCtx, src.Unit.ID)
				if err != nil {
					return err
				}

				_, err = qtx.AddProjectEntitySource(gCtx, db.AddProjectEntitySourceParams{
					PublicID:    src.ID,
					EntityID:    id,
					TextUnitID:  unit.ID,
					Description: src.Description,
					Embedding:   embed,
				})

				if err != nil {
					return err
				}

				return nil
			})
		}

		if err := eg.Wait(); err != nil {
			return nil, err
		}

		ids = append(ids, id)
	}

	err = trx.Commit(ctx)
	if err != nil {
		return nil, err
	}

	return ids, nil
}
