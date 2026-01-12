package base

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"kiwi/internal/db"
	"kiwi/pkg/ai"
	"kiwi/pkg/common"
)

// entityPair represents two potentially duplicate entities
type entityPair struct {
	ID1       int64
	PublicID1 string
	Name1     string
	Type1     string
	ID2       int64
	PublicID2 string
	Name2     string
	Type2     string
}

// entityWithMeta holds entity data plus DB id and source count
type entityWithMeta struct {
	common.Entity
	DBID        int64
	SourceCount int
}

// DedupeAndMergeEntities finds and merges duplicate entities in the DB.
// All changes are wrapped in a transaction - rolls back on any error.
func (s *GraphDBStorage) DedupeAndMergeEntities(
	ctx context.Context,
	graphID string,
	aiClient ai.GraphAIClient,
) error {
	projectID, err := strconv.ParseInt(graphID, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid graph ID: %w", err)
	}

	// Start transaction for rollback on failure
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	qtx := db.New(s.conn).WithTx(tx)

	// 1. Find similar entity pairs using pg_trgm
	pairs, err := s.findSimilarEntityPairs(ctx, qtx, projectID)
	if err != nil {
		return fmt.Errorf("failed to find similar entities: %w", err)
	}

	if len(pairs) == 0 {
		return tx.Commit(ctx)
	}

	groups := buildConnectedComponents(pairs)

	for _, group := range groups {
		if len(group) <= 1 {
			continue
		}

		entities, err := s.getEntitiesWithMeta(ctx, qtx, group)
		if err != nil {
			return fmt.Errorf("failed to get entities: %w", err)
		}

		commonEntities := make([]common.Entity, len(entities))
		for i, e := range entities {
			commonEntities[i] = e.Entity
		}

		batchSize := ai.GetDedupeBatchSize()
		if len(commonEntities) > batchSize {
			// NOTE: Large connected components are truncated to batch size.
			// Entities beyond this limit won't be processed in this pass.
			// This is a performance tradeoff to limit AI call size.
			commonEntities = commonEntities[:batchSize]
			entities = entities[:batchSize]
		}

		dupeResponse, err := ai.CallDedupeAI(ctx, commonEntities, aiClient, 3)
		if err != nil {
			return fmt.Errorf("AI dedupe failed: %w", err)
		}

		err = s.applyEntityMerges(ctx, qtx, projectID, entities, dupeResponse)
		if err != nil {
			return fmt.Errorf("failed to merge entities: %w", err)
		}
	}

	err = s.dedupeRelationships(ctx, qtx, projectID)
	if err != nil {
		return fmt.Errorf("failed to dedupe relationships: %w", err)
	}

	return tx.Commit(ctx)
}

// findSimilarEntityPairs uses pg_trgm to find entities with similar names
func (s *GraphDBStorage) findSimilarEntityPairs(
	ctx context.Context,
	qtx *db.Queries,
	projectID int64,
) ([]entityPair, error) {
	rows, err := qtx.FindEntitiesWithSimilarNames(ctx, projectID)
	if err != nil {
		return nil, err
	}

	pairs := make([]entityPair, len(rows))
	for i, row := range rows {
		pairs[i] = entityPair{
			ID1:       row.Id1,
			PublicID1: row.PublicId1,
			Name1:     row.Name1,
			Type1:     row.Type1,
			ID2:       row.Id2,
			PublicID2: row.PublicId2,
			Name2:     row.Name2,
			Type2:     row.Type2,
		}
	}
	return pairs, nil
}

// buildConnectedComponents groups entity IDs that are transitively similar
// Uses union-find algorithm
func buildConnectedComponents(pairs []entityPair) [][]int64 {
	parent := make(map[int64]int64)

	var find func(x int64) int64
	find = func(x int64) int64 {
		if _, ok := parent[x]; !ok {
			parent[x] = x
		}
		if parent[x] != x {
			parent[x] = find(parent[x])
		}
		return parent[x]
	}

	union := func(x, y int64) {
		px, py := find(x), find(y)
		if px != py {
			parent[px] = py
		}
	}

	// Build unions from pairs
	for _, p := range pairs {
		union(p.ID1, p.ID2)
	}

	// Group by root
	components := make(map[int64][]int64)
	for id := range parent {
		root := find(id)
		components[root] = append(components[root], id)
	}

	// Convert to slice
	result := make([][]int64, 0, len(components))
	for _, group := range components {
		if len(group) > 1 {
			result = append(result, group)
		}
	}
	return result
}

// getEntitiesWithMeta fetches entities with their source counts
func (s *GraphDBStorage) getEntitiesWithMeta(
	ctx context.Context,
	qtx *db.Queries,
	ids []int64,
) ([]entityWithMeta, error) {
	entities, err := qtx.GetProjectEntitiesByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}

	result := make([]entityWithMeta, len(entities))
	for i, e := range entities {
		count, err := qtx.CountEntitySources(ctx, e.ID)
		if err != nil {
			return nil, err
		}

		result[i] = entityWithMeta{
			Entity: common.Entity{
				ID:          e.PublicID,
				Name:        e.Name,
				Type:        e.Type,
				Description: e.Description,
			},
			DBID:        e.ID,
			SourceCount: int(count),
		}
	}
	return result, nil
}

// applyEntityMerges applies the AI dedupe results to merge entities
func (s *GraphDBStorage) applyEntityMerges(
	ctx context.Context,
	qtx *db.Queries,
	projectID int64,
	entities []entityWithMeta,
	dupeResponse *ai.DuplicatesResponse,
) error {
	// Build lookup by name (uppercase for matching)
	entityByName := make(map[string]*entityWithMeta)
	for i := range entities {
		key := strings.ToUpper(strings.TrimSpace(entities[i].Name))
		entityByName[key] = &entities[i]
	}

	for _, group := range dupeResponse.Duplicates {
		if len(group.Entities) <= 1 {
			continue
		}

		// Find all entities in this duplicate group
		var groupEntities []*entityWithMeta
		for _, name := range group.Entities {
			key := strings.ToUpper(strings.TrimSpace(name))
			if e, ok := entityByName[key]; ok {
				groupEntities = append(groupEntities, e)
			}
		}

		if len(groupEntities) <= 1 {
			continue
		}

		// Select canonical (most sources)
		canonical := groupEntities[0]
		for _, e := range groupEntities[1:] {
			if e.SourceCount > canonical.SourceCount {
				canonical = e
			}
		}

		// Update canonical entity name to AI-chosen name
		err := qtx.UpdateEntityName(ctx, db.UpdateEntityNameParams{
			ID:   canonical.DBID,
			Name: group.Name,
		})
		if err != nil {
			return fmt.Errorf("failed to update canonical name: %w", err)
		}

		// Merge non-canonical into canonical
		for _, dupe := range groupEntities {
			if dupe.DBID == canonical.DBID {
				continue
			}

			// Transfer sources
			err := qtx.TransferEntitySources(ctx, db.TransferEntitySourcesParams{
				EntityID:   dupe.DBID,
				EntityID_2: canonical.DBID,
			})
			if err != nil {
				return fmt.Errorf("failed to transfer sources: %w", err)
			}

			// Update relationships pointing to dupe
			err = qtx.UpdateRelationshipSourceEntity(ctx, db.UpdateRelationshipSourceEntityParams{
				SourceID:   dupe.DBID,
				SourceID_2: canonical.DBID,
				ProjectID:  projectID,
			})
			if err != nil {
				return fmt.Errorf("failed to update relationship sources: %w", err)
			}

			err = qtx.UpdateRelationshipTargetEntity(ctx, db.UpdateRelationshipTargetEntityParams{
				TargetID:   dupe.DBID,
				TargetID_2: canonical.DBID,
				ProjectID:  projectID,
			})
			if err != nil {
				return fmt.Errorf("failed to update relationship targets: %w", err)
			}

			// Delete duplicate entity
			err = qtx.DeleteProjectEntity(ctx, dupe.DBID)
			if err != nil {
				return fmt.Errorf("failed to delete duplicate entity: %w", err)
			}
		}
	}

	return nil
}

// dedupeRelationships merges duplicate relationships (same source-target pair)
func (s *GraphDBStorage) dedupeRelationships(
	ctx context.Context,
	qtx *db.Queries,
	projectID int64,
) error {
	dupePairs, err := qtx.FindDuplicateRelationships(ctx, projectID)
	if err != nil {
		return err
	}

	// Track already deleted IDs to avoid double processing
	deleted := make(map[int64]bool)

	for _, pair := range dupePairs {
		if deleted[pair.Id1] || deleted[pair.Id2] {
			continue
		}

		// Transfer sources from r2 to r1
		err := qtx.TransferRelationshipSources(ctx, db.TransferRelationshipSourcesParams{
			RelationshipID:   pair.Id2,
			RelationshipID_2: pair.Id1,
		})
		if err != nil {
			return fmt.Errorf("failed to transfer relationship sources: %w", err)
		}

		// Average the ranks
		newRank := (pair.Rank1 + pair.Rank2) / 2
		err = qtx.UpdateRelationshipRank(ctx, db.UpdateRelationshipRankParams{
			Rank: newRank,
			ID:   pair.Id1,
		})
		if err != nil {
			return fmt.Errorf("failed to update relationship rank: %w", err)
		}

		// Delete r2
		err = qtx.DeleteProjectRelationship(ctx, pair.Id2)
		if err != nil {
			return fmt.Errorf("failed to delete duplicate relationship: %w", err)
		}

		deleted[pair.Id2] = true
	}

	return nil
}
