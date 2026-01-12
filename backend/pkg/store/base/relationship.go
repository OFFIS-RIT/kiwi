package base

import (
	"context"
	"fmt"
	"kiwi/internal/db"
	"slices"
	"strconv"

	"kiwi/pkg/common"

	"github.com/pgvector/pgvector-go"
	"golang.org/x/sync/errgroup"
)

func (s *GraphDBStorage) AddRelationship(
	ctx context.Context,
	qtx *db.Queries,
	relation *common.Relationship,
	projectId int64,
	sourceID int64,
	targetID int64,
) (int64, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(relation.Description))
	if err != nil {
		return -1, err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	id, err := qtx.AddProjectRelationship(ctx, db.AddProjectRelationshipParams{
		PublicID:    relation.ID,
		ProjectID:   projectId,
		SourceID:    sourceID,
		TargetID:    targetID,
		Description: relation.Description,
		Rank:        relation.Strength,
		Embedding:   embed,
	})
	s.dbLock.Unlock()
	if err != nil {
		return -1, nil
	}

	return id, nil
}

func (s *GraphDBStorage) AddRelationshipSource(
	ctx context.Context,
	qtx *db.Queries,
	source *common.Source,
	relationId int64,
	textUnitId int64,
) (int64, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(source.Description))
	if err != nil {
		return -1, err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	id, err := qtx.AddProjectRelationshipSource(ctx, db.AddProjectRelationshipSourceParams{
		PublicID:       source.ID,
		RelationshipID: relationId,
		TextUnitID:     textUnitId,
		Description:    source.Description,
		Embedding:      embed,
	})
	s.dbLock.Unlock()
	if err != nil {
		return -1, err
	}

	return id, nil
}

func (s *GraphDBStorage) GetRelationshipByProjectID(
	ctx context.Context,
	qtx *db.Queries,
	projectId int64,
) ([]int64, []common.Relationship, error) {
	relations, err := qtx.GetProjectRelationships(ctx, projectId)
	if err != nil {
		return nil, nil, err
	}

	ids := make([]int64, len(relations))
	relationships := make([]common.Relationship, len(relations))
	for idx := range relations {
		rel := relations[idx]
		ids[idx] = rel.ID

		dbSource, err := qtx.GetProjectEntityByID(ctx, rel.SourceID)
		if err != nil {
			return nil, nil, err
		}
		dbTarget, err := qtx.GetProjectEntityByID(ctx, rel.TargetID)
		if err != nil {
			return nil, nil, err
		}

		source := &common.Entity{
			Name: dbSource.Name,
			ID:   dbSource.PublicID,
		}
		target := &common.Entity{
			Name: dbTarget.Name,
			ID:   dbTarget.PublicID,
		}

		relationships[idx] = common.Relationship{
			ID:          rel.PublicID,
			Description: rel.Description,
			Strength:    rel.Rank,
			Source:      source,
			Target:      target,
		}
	}

	return ids, relationships, nil
}

func (s *GraphDBStorage) UpdateRelationshipByPublicID(
	ctx context.Context,
	qtx *db.Queries,
	relation common.Relationship,
) (int64, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(relation.Description))
	if err != nil {
		return -1, err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	defer s.dbLock.Unlock()
	return qtx.UpdateProjectRelationship(ctx, db.UpdateProjectRelationshipParams{
		PublicID:    relation.ID,
		Description: relation.Description,
		Rank:        relation.Strength,
		Embedding:   embed,
	})
}

func (s *GraphDBStorage) getPathBetweenEntities(
	ctx context.Context,
	conn pgxIConn,
	sourceId int64,
	targetId int64,
	graphId string,
) ([]int64, []int64, []common.Relationship, error) {
	query := fmt.Sprintf(`
		WITH route AS (
			SELECT *
			FROM pgr_dijkstra(
				'SELECT
					id,
					source_id AS source,
					target_id AS target,
					1.0 / NULLIF(rank, 0) AS cost
				FROM relationships
				WHERE project_id = %s',
				$1::bigint,
				$2::bigint,
				directed := false
			)
		),
		best_path AS (
			SELECT
				path_seq,
				node AS node_id,
				edge AS rel_id,
				cost
			FROM route
		)
		SELECT
			r.id,
			r.public_id,
			r.description,
			r.rank,
			r.source_id,
			r.target_id
		FROM best_path bp
		JOIN relationships r ON r.id = bp.rel_id
		ORDER BY bp.path_seq;
	`, graphId)

	rows, err := conn.Query(
		ctx,
		query,
		sourceId,
		targetId,
	)
	if err != nil {
		return nil, nil, nil, err
	}
	defer rows.Close()

	ids := make([]int64, 0)
	relations := make([]common.Relationship, 0)
	entityIds := make([]int64, 0)

	for rows.Next() {
		var id int64
		var sourceId int64
		var targetId int64
		var relation common.Relationship
		err := rows.Scan(
			&id,
			&relation.ID,
			&relation.Description,
			&relation.Strength,
			&sourceId,
			&targetId,
		)
		if err != nil {
			return nil, nil, nil, err
		}

		relations = append(relations, relation)
		ids = append(ids, id)
		if !slices.Contains(entityIds, sourceId) {
			entityIds = append(entityIds, sourceId)
		}
		if !slices.Contains(entityIds, targetId) {
			entityIds = append(entityIds, targetId)
		}
	}

	return ids, entityIds, relations, nil
}

// SaveRelationships persists a batch of relationships and their sources to the
// database. It generates vector embeddings for semantic search and links each
// relationship to its source and target entities. All operations are wrapped
// in a single transaction.
func (s *GraphDBStorage) SaveRelationships(ctx context.Context, relations []common.Relationship, graphId string) ([]int64, error) {
	ids := make([]int64, 0, len(relations))

	trx, err := s.conn.Begin(ctx)
	if err != nil {
		return nil, err
	}

	q := db.New(s.conn)
	qtx := q.WithTx(trx)

	for _, relation := range relations {
		embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(relation.Description))
		if err != nil {
			return nil, err
		}
		embed := pgvector.NewVector(embedding)

		gId, err := strconv.ParseInt(graphId, 10, 64)
		if err != nil {
			return nil, err
		}

		source, err := qtx.GetProjectEntityByPublicID(ctx, relation.Source.ID)
		if err != nil {
			return nil, err
		}
		target, err := qtx.GetProjectEntityByPublicID(ctx, relation.Target.ID)
		if err != nil {
			return nil, err
		}

		id, err := qtx.AddProjectRelationship(ctx, db.AddProjectRelationshipParams{
			PublicID:    relation.ID,
			ProjectID:   gId,
			SourceID:    source.ID,
			TargetID:    target.ID,
			Description: relation.Description,
			Rank:        relation.Strength,
			Embedding:   embed,
		})
		if err != nil {
			return nil, err
		}

		eg, gCtx := errgroup.WithContext(ctx)
		eg.SetLimit(s.maxParallel)

		for _, src := range relation.Sources {
			sSrc := src

			eg.Go(func() error {
				srcEmbedding, err := s.aiClient.GenerateEmbedding(gCtx, []byte(sSrc.Description))
				if err != nil {
					return err
				}
				srcEmbed := pgvector.NewVector(srcEmbedding)

				s.dbLock.Lock()
				defer s.dbLock.Unlock()

				unit, err := qtx.GetTextUnitByPublicId(gCtx, sSrc.Unit.ID)
				if err != nil {
					return err
				}

				_, err = qtx.AddProjectRelationshipSource(gCtx, db.AddProjectRelationshipSourceParams{
					PublicID:       sSrc.ID,
					RelationshipID: id,
					TextUnitID:     unit.ID,
					Description:    sSrc.Description,
					Embedding:      srcEmbed,
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
