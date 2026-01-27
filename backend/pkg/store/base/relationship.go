package base

import (
	"context"
	"fmt"
	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"slices"
	"strconv"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/pgvector/pgvector-go"
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
		return -1, err
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
// relationship to its source and target entities.
func (s *GraphDBStorage) SaveRelationships(ctx context.Context, relations []common.Relationship, graphId string) ([]int64, error) {
	if len(relations) == 0 {
		return nil, nil
	}

	projectID, err := strconv.ParseInt(graphId, 10, 64)
	if err != nil {
		return nil, err
	}

	relChunk := 250
	sourceChunk := 500

	ids := make([]int64, 0, len(relations))

	err = chunkRange(len(relations), relChunk, func(start, end int) error {
		merged := mergeRelationshipsByPublicID(relations[start:end])
		if len(merged) == 0 {
			return nil
		}

		logger.Debug("[Graph][SaveRelationships] Saving chunk", "relationships", len(merged))

		tx, err := s.conn.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		qtx := db.New(tx)

		entityPublicIDs := make([]string, 0, len(merged)*2)
		for _, r := range merged {
			if r.Source != nil {
				entityPublicIDs = append(entityPublicIDs, r.Source.ID)
			}
			if r.Target != nil {
				entityPublicIDs = append(entityPublicIDs, r.Target.ID)
			}
		}
		entityRows, err := qtx.GetEntityIDsByPublicIDs(ctx, db.GetEntityIDsByPublicIDsParams{
			ProjectID: projectID,
			PublicIds: dedupeStrings(entityPublicIDs),
		})
		if err != nil {
			return err
		}
		entityIDByPublicID := make(map[string]int64, len(entityRows))
		for _, r := range entityRows {
			entityIDByPublicID[r.PublicID] = r.ID
		}

		relInputs := make([][]byte, len(merged))
		for i := range merged {
			relInputs[i] = []byte(merged[i].Description)
		}
		logger.Debug("[Graph][SaveRelationships] Generating relationship embeddings", "count", len(relInputs))
		relEmb, err := generateEmbeddings(ctx, s.aiClient, relInputs)
		if err != nil {
			return err
		}

		relPublicIDs := make([]string, 0, len(merged))
		sourceIDs := make([]int64, 0, len(merged))
		targetIDs := make([]int64, 0, len(merged))
		ranks := make([]float64, 0, len(merged))
		descriptions := make([]string, 0, len(merged))
		embeddings := make([]pgvector.Vector, 0, len(merged))
		for i, r := range merged {
			if r.ID == "" {
				return fmt.Errorf("relationship public_id is empty")
			}
			if r.Source == nil || r.Target == nil {
				return fmt.Errorf("relationship missing source/target: public_id=%s", r.ID)
			}
			sID, ok := entityIDByPublicID[r.Source.ID]
			if !ok {
				return fmt.Errorf("missing source entity: relationship=%s entity_public_id=%s", r.ID, r.Source.ID)
			}
			tID, ok := entityIDByPublicID[r.Target.ID]
			if !ok {
				return fmt.Errorf("missing target entity: relationship=%s entity_public_id=%s", r.ID, r.Target.ID)
			}
			relPublicIDs = append(relPublicIDs, r.ID)
			sourceIDs = append(sourceIDs, sID)
			targetIDs = append(targetIDs, tID)
			ranks = append(ranks, r.Strength)
			descriptions = append(descriptions, r.Description)
			embeddings = append(embeddings, pgvector.NewVector(relEmb[i]))
		}

		logger.Debug("[Graph][SaveRelationships] Bulk upserting relationships", "count", len(merged))
		relRows, err := qtx.UpsertProjectRelationships(ctx, db.UpsertProjectRelationshipsParams{
			ProjectID:    projectID,
			SourceIds:    sourceIDs,
			TargetIds:    targetIDs,
			Ranks:        ranks,
			Descriptions: descriptions,
			Embeddings:   embeddings,
			PublicIds:    relPublicIDs,
		})
		if err != nil {
			return err
		}

		relIDByPublicID := make(map[string]int64, len(relRows))
		for _, r := range relRows {
			relIDByPublicID[r.PublicID] = r.ID
			ids = append(ids, r.ID)
		}

		sources := flattenRelationshipSources(merged, relIDByPublicID)
		if len(sources) > 0 {
			err = chunkRange(len(sources), sourceChunk, func(sStart, sEnd int) error {
				part := sources[sStart:sEnd]
				logger.Debug("[Graph][SaveRelationships] Saving relationship sources chunk", "sources", len(part))

				unitPublicIDs := make([]string, 0, len(part))
				for _, src := range part {
					unitPublicIDs = append(unitPublicIDs, src.unitPublicID)
				}
				unitRows, err := qtx.GetTextUnitIDsByPublicIDs(ctx, dedupeStrings(unitPublicIDs))
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
				logger.Debug("[Graph][SaveRelationships] Generating relationship source embeddings", "count", len(inputs))
				embs, err := generateEmbeddings(ctx, s.aiClient, inputs)
				if err != nil {
					return err
				}

				sPublicIDs := make([]string, 0, len(part))
				sRelIDs := make([]int64, 0, len(part))
				sUnitIDs := make([]int64, 0, len(part))
				sDescriptions := make([]string, 0, len(part))
				sEmbeddings := make([]pgvector.Vector, 0, len(part))
				for i := range part {
					unitID, ok := unitIDByPublicID[part[i].unitPublicID]
					if !ok {
						return fmt.Errorf("missing text unit for source: unit_public_id=%s", part[i].unitPublicID)
					}
					sPublicIDs = append(sPublicIDs, part[i].publicID)
					sRelIDs = append(sRelIDs, part[i].relationshipID)
					sUnitIDs = append(sUnitIDs, unitID)
					sDescriptions = append(sDescriptions, part[i].description)
					sEmbeddings = append(sEmbeddings, pgvector.NewVector(embs[i]))
				}

				logger.Debug("[Graph][SaveRelationships] Bulk upserting relationship sources", "count", len(part))
				return qtx.UpsertRelationshipSources(ctx, db.UpsertRelationshipSourcesParams{
					RelationshipIds: sRelIDs,
					TextUnitIds:     sUnitIDs,
					Descriptions:    sDescriptions,
					Embeddings:      sEmbeddings,
					PublicIds:       sPublicIDs,
				})
			})
			if err != nil {
				return err
			}
		}

		logger.Debug("[Graph][SaveRelationships] Chunk committed", "relationships", len(merged))
		return tx.Commit(ctx)
	})
	if err != nil {
		return nil, err
	}

	return ids, nil
}

type relationshipSourceRow struct {
	publicID       string
	relationshipID int64
	unitPublicID   string
	description    string
}

func mergeRelationshipsByPublicID(in []common.Relationship) []common.Relationship {
	byID := make(map[string]int, len(in))
	out := make([]common.Relationship, 0, len(in))
	for _, r := range in {
		if r.ID == "" {
			continue
		}
		if idx, ok := byID[r.ID]; ok {
			if r.Description != "" {
				out[idx].Description = r.Description
			}
			if r.Source != nil {
				out[idx].Source = r.Source
			}
			if r.Target != nil {
				out[idx].Target = r.Target
			}
			out[idx].Strength = r.Strength
			if len(r.Sources) > 0 {
				out[idx].Sources = append(out[idx].Sources, r.Sources...)
			}
			continue
		}
		byID[r.ID] = len(out)
		out = append(out, r)
	}
	return out
}

func flattenRelationshipSources(relations []common.Relationship, relIDByPublicID map[string]int64) []relationshipSourceRow {
	rows := make([]relationshipSourceRow, 0)
	indexByPublicID := make(map[string]int)
	for _, r := range relations {
		relID, ok := relIDByPublicID[r.ID]
		if !ok {
			continue
		}
		for _, src := range r.Sources {
			if src.ID == "" || src.Unit == nil || src.Unit.ID == "" {
				continue
			}
			row := relationshipSourceRow{
				publicID:       src.ID,
				relationshipID: relID,
				unitPublicID:   src.Unit.ID,
				description:    src.Description,
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
