package pgx

import (
	"context"
	"fmt"
	"slices"
	"sort"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"

	"github.com/pgvector/pgvector-go"
)

func (s *GraphDBStorage) GetRelationshipByProjectID(
	ctx context.Context,
	qtx *pgdb.Queries,
	projectId string,
) ([]string, []common.Relationship, error) {
	relations, err := qtx.GetProjectRelationships(ctx, projectId)
	if err != nil {
		return nil, nil, err
	}

	ids := make([]string, len(relations))
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
			ID:   dbSource.ID,
		}
		target := &common.Entity{
			Name: dbTarget.Name,
			ID:   dbTarget.ID,
		}

		relationships[idx] = common.Relationship{
			ID:          rel.ID,
			Description: rel.Description,
			Strength:    rel.Rank,
			Source:      source,
			Target:      target,
		}
	}

	return ids, relationships, nil
}

func (s *GraphDBStorage) UpdateRelationshipByID(
	ctx context.Context,
	qtx *pgdb.Queries,
	relation common.Relationship,
) (string, error) {
	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(relation.Description))
	if err != nil {
		return "", err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	defer s.dbLock.Unlock()
	return qtx.UpdateProjectRelationship(ctx, pgdb.UpdateProjectRelationshipParams{
		ID:          relation.ID,
		Description: relation.Description,
		Rank:        relation.Strength,
		Embedding:   embed,
	})
}

func (s *GraphDBStorage) getPathBetweenEntities(
	ctx context.Context,
	conn pgxIConn,
	sourceId string,
	targetId string,
	graphId string,
) ([]string, []string, []common.Relationship, error) {
	q := pgdb.New(conn)
	rows, err := q.GetProjectRelationships(ctx, graphId)
	if err != nil {
		return nil, nil, nil, err
	}

	type edge struct {
		rel  pgdb.GetProjectRelationshipsRow
		next string
		cost float64
	}
	adjacency := make(map[string][]edge)
	for _, row := range rows {
		cost := 1.0
		if row.Rank > 0 {
			cost = 1.0 / row.Rank
		}
		adjacency[row.SourceID] = append(adjacency[row.SourceID], edge{rel: row, next: row.TargetID, cost: cost})
		adjacency[row.TargetID] = append(adjacency[row.TargetID], edge{rel: row, next: row.SourceID, cost: cost})
	}

	if sourceId == "" || targetId == "" {
		return nil, nil, nil, nil
	}
	if sourceId == targetId {
		return nil, []string{sourceId}, nil, nil
	}

	dist := map[string]float64{sourceId: 0}
	visited := make(map[string]bool)
	prevEntity := make(map[string]string)
	prevRel := make(map[string]pgdb.GetProjectRelationshipsRow)
	queue := []string{sourceId}

	for len(queue) > 0 {
		bestIdx := 0
		bestID := queue[0]
		bestDist := dist[bestID]
		for i := 1; i < len(queue); i++ {
			candidateID := queue[i]
			candidateDist := dist[candidateID]
			if candidateDist < bestDist || (candidateDist == bestDist && candidateID < bestID) {
				bestIdx = i
				bestID = candidateID
				bestDist = candidateDist
			}
		}
		queue = append(queue[:bestIdx], queue[bestIdx+1:]...)
		if visited[bestID] {
			continue
		}
		visited[bestID] = true
		if bestID == targetId {
			break
		}
		for _, edge := range adjacency[bestID] {
			if visited[edge.next] {
				continue
			}
			candidateDist := bestDist + edge.cost
			currentDist, ok := dist[edge.next]
			if !ok || candidateDist < currentDist || (candidateDist == currentDist && edge.rel.ID < prevRel[edge.next].ID) {
				dist[edge.next] = candidateDist
				prevEntity[edge.next] = bestID
				prevRel[edge.next] = edge.rel
				if !slices.Contains(queue, edge.next) {
					queue = append(queue, edge.next)
				}
			}
		}
	}

	if _, ok := dist[targetId]; !ok {
		return nil, nil, nil, nil
	}

	pathRelations := make([]pgdb.GetProjectRelationshipsRow, 0)
	entitySet := map[string]struct{}{sourceId: {}, targetId: {}}
	for current := targetId; current != sourceId; current = prevEntity[current] {
		rel, ok := prevRel[current]
		if !ok {
			return nil, nil, nil, nil
		}
		pathRelations = append(pathRelations, rel)
		entitySet[rel.SourceID] = struct{}{}
		entitySet[rel.TargetID] = struct{}{}
	}
	slices.Reverse(pathRelations)

	relationIDs := make([]string, 0, len(pathRelations))
	relations := make([]common.Relationship, 0, len(pathRelations))
	for _, rel := range pathRelations {
		relationIDs = append(relationIDs, rel.ID)
		relations = append(relations, common.Relationship{
			ID:          rel.ID,
			Description: rel.Description,
			Strength:    rel.Rank,
			Source:      &common.Entity{ID: rel.SourceID},
			Target:      &common.Entity{ID: rel.TargetID},
		})
	}
	entityIDs := make([]string, 0, len(entitySet))
	for id := range entitySet {
		entityIDs = append(entityIDs, id)
	}
	sort.Strings(entityIDs)

	return relationIDs, entityIDs, relations, nil
}

// SaveRelationships persists a batch of relationships and their sources to the
// database. It generates vector embeddings for semantic search and links each
// relationship to its source and target entities.
func (s *GraphDBStorage) SaveRelationships(ctx context.Context, relations []common.Relationship, graphId string) ([]string, error) {
	if len(relations) == 0 {
		return nil, nil
	}

	relChunk := 250
	sourceChunk := 500

	ids := make([]string, 0, len(relations))
	projectID := graphId

	err := store.ChunkRange(len(relations), relChunk, func(start, end int) error {
		merged := mergeRelationshipsByID(relations[start:end])
		if len(merged) == 0 {
			return nil
		}

		logger.Debug("[Graph][SaveRelationships] Saving chunk", "relationships", len(merged))

		tx, err := s.conn.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		qtx := pgdb.New(tx)

		relInputs := make([][]byte, len(merged))
		for i := range merged {
			relInputs[i] = []byte(merged[i].Description)
		}
		logger.Debug("[Graph][SaveRelationships] Generating relationship embeddings", "count", len(relInputs))
		relEmb, err := store.GenerateEmbeddings(ctx, s.aiClient, relInputs)
		if err != nil {
			return err
		}

		relIDs := make([]string, 0, len(merged))
		sourceIDs := make([]string, 0, len(merged))
		targetIDs := make([]string, 0, len(merged))
		ranks := make([]float64, 0, len(merged))
		descriptions := make([]string, 0, len(merged))
		embeddings := make([]pgvector.Vector, 0, len(merged))
		for i, r := range merged {
			if r.ID == "" {
				return fmt.Errorf("relationship id is empty")
			}
			if r.Source == nil || r.Target == nil {
				return fmt.Errorf("relationship missing source/target: id=%s", r.ID)
			}
			if r.Source.ID == "" {
				return fmt.Errorf("missing source entity id: relationship=%s", r.ID)
			}
			if r.Target.ID == "" {
				return fmt.Errorf("missing target entity id: relationship=%s", r.ID)
			}
			relIDs = append(relIDs, r.ID)
			sourceIDs = append(sourceIDs, r.Source.ID)
			targetIDs = append(targetIDs, r.Target.ID)
			ranks = append(ranks, r.Strength)
			descriptions = append(descriptions, r.Description)
			embeddings = append(embeddings, pgvector.NewVector(relEmb[i]))
		}

		logger.Debug("[Graph][SaveRelationships] Bulk upserting relationships", "count", len(merged))
		relRows, err := qtx.UpsertProjectRelationships(ctx, pgdb.UpsertProjectRelationshipsParams{
			ProjectID:    projectID,
			SourceIds:    sourceIDs,
			TargetIds:    targetIDs,
			Ranks:        ranks,
			Descriptions: descriptions,
			Embeddings:   embeddings,
			Ids:          relIDs,
		})
		if err != nil {
			return err
		}

		ids = append(ids, relRows...)

		sources := flattenRelationshipSources(merged)
		if len(sources) > 0 {
			err = store.ChunkRange(len(sources), sourceChunk, func(sStart, sEnd int) error {
				part := sources[sStart:sEnd]
				logger.Debug("[Graph][SaveRelationships] Saving relationship sources chunk", "sources", len(part))

				inputs := make([][]byte, len(part))
				for i := range part {
					inputs[i] = []byte(part[i].description)
				}
				logger.Debug("[Graph][SaveRelationships] Generating relationship source embeddings", "count", len(inputs))
				embs, err := store.GenerateEmbeddings(ctx, s.aiClient, inputs)
				if err != nil {
					return err
				}

				sIDs := make([]string, 0, len(part))
				sRelIDs := make([]string, 0, len(part))
				sUnitIDs := make([]string, 0, len(part))
				sDescriptions := make([]string, 0, len(part))
				sEmbeddings := make([]pgvector.Vector, 0, len(part))
				for i := range part {
					if part[i].unitID == "" {
						return fmt.Errorf("missing text unit for source: source_id=%s", part[i].id)
					}
					sIDs = append(sIDs, part[i].id)
					sRelIDs = append(sRelIDs, part[i].relationshipID)
					sUnitIDs = append(sUnitIDs, part[i].unitID)
					sDescriptions = append(sDescriptions, part[i].description)
					sEmbeddings = append(sEmbeddings, pgvector.NewVector(embs[i]))
				}

				logger.Debug("[Graph][SaveRelationships] Bulk upserting relationship sources", "count", len(part))
				return qtx.UpsertRelationshipSources(ctx, pgdb.UpsertRelationshipSourcesParams{
					Ids:             sIDs,
					RelationshipIds: sRelIDs,
					TextUnitIds:     sUnitIDs,
					Descriptions:    sDescriptions,
					Embeddings:      sEmbeddings,
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
	id             string
	relationshipID string
	unitID         string
	description    string
}

func mergeRelationshipsByID(in []common.Relationship) []common.Relationship {
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

func flattenRelationshipSources(relations []common.Relationship) []relationshipSourceRow {
	rows := make([]relationshipSourceRow, 0)
	indexByID := make(map[string]int)
	for _, r := range relations {
		if r.ID == "" {
			continue
		}
		for _, src := range r.Sources {
			if src.ID == "" || src.Unit == nil || src.Unit.ID == "" {
				continue
			}
			row := relationshipSourceRow{
				id:             src.ID,
				relationshipID: r.ID,
				unitID:         src.Unit.ID,
				description:    src.Description,
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
