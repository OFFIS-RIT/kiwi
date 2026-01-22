package base

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

const maxDedupeIterations = 100

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

	for iteration := 1; iteration <= maxDedupeIterations; iteration++ {
		pairs, err := s.findSimilarEntityPairs(ctx, qtx, projectID)
		if err != nil {
			return fmt.Errorf("failed to find similar entities: %w", err)
		}
		if len(pairs) == 0 {
			logger.Debug("[Dedupe] No similar entity pairs found", "iteration", iteration)
			break
		}

		groups := buildConnectedComponents(pairs)
		logger.Debug("[Dedupe] Processing entity groups", "iteration", iteration, "groups", len(groups))

		iterationMerged := false
		for _, group := range groups {
			if len(group) <= 1 {
				continue
			}
			merged, err := s.dedupeEntityGroup(ctx, qtx, projectID, group, aiClient, iteration)
			if err != nil {
				return fmt.Errorf("failed to merge entities: %w", err)
			}
			if merged {
				iterationMerged = true
			}
		}

		err = s.dedupeRelationships(ctx, qtx, projectID)
		if err != nil {
			return fmt.Errorf("failed to dedupe relationships: %w", err)
		}

		if !iterationMerged {
			logger.Warn("[Dedupe] No merges detected in iteration", "iteration", iteration)
			break
		}

		if iteration == maxDedupeIterations {
			logger.Warn("[Dedupe] Max iterations reached before convergence", "iteration", iteration)
			break
		}
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

func (s *GraphDBStorage) dedupeEntityGroup(
	ctx context.Context,
	qtx *db.Queries,
	projectID int64,
	group []int64,
	aiClient ai.GraphAIClient,
	iteration int,
) (bool, error) {
	entities, err := s.getEntitiesWithMeta(ctx, qtx, group)
	if err != nil {
		return false, fmt.Errorf("failed to get entities: %w", err)
	}
	if len(entities) <= 1 {
		return false, nil
	}

	batchSize := ai.GetDedupeBatchSize()
	ordered := reorderEntitiesWithMeta(entities, iteration, batchSize)
	merged := false

	for i := 0; i < len(ordered); i += batchSize {
		end := i + batchSize
		if end > len(ordered) {
			end = len(ordered)
		}
		chunk := ordered[i:end]
		commonEntities := make([]common.Entity, len(chunk))
		for idx, e := range chunk {
			commonEntities[idx] = e.Entity
		}

		dupeResponse, err := ai.CallDedupeAI(ctx, commonEntities, aiClient, 3)
		if err != nil {
			return false, fmt.Errorf("AI dedupe failed: %w", err)
		}
		if !hasDuplicateGroups(dupeResponse) {
			continue
		}

		if err := s.applyEntityMerges(ctx, qtx, projectID, chunk, dupeResponse); err != nil {
			return false, err
		}
		merged = true
	}

	return merged, nil
}

func hasDuplicateGroups(res *ai.DuplicatesResponse) bool {
	for _, group := range res.Duplicates {
		if len(group.Entities) > 1 {
			return true
		}
	}
	return false
}

func reorderEntitiesWithMeta(entities []entityWithMeta, iteration int, batchSize int) []entityWithMeta {
	reordered := make([]entityWithMeta, len(entities))
	copy(reordered, entities)

	switch iteration % 3 {
	case 1:
		return reordered
	case 2:
		return interleaveEntitiesWithMeta(reordered, batchSize)
	default:
		sort.Slice(reordered, func(i, j int) bool {
			left := strings.ToUpper(strings.TrimSpace(reordered[i].Name)) + "|" + strings.ToUpper(strings.TrimSpace(reordered[i].Type))
			right := strings.ToUpper(strings.TrimSpace(reordered[j].Name)) + "|" + strings.ToUpper(strings.TrimSpace(reordered[j].Type))
			return left < right
		})
		return reordered
	}
}

func interleaveEntitiesWithMeta(entities []entityWithMeta, batchSize int) []entityWithMeta {
	if batchSize <= 0 {
		return entities
	}

	batchCount := (len(entities) + batchSize - 1) / batchSize
	result := make([]entityWithMeta, 0, len(entities))
	for i := 0; i < batchSize; i++ {
		for batch := 0; batch < batchCount; batch++ {
			idx := batch*batchSize + i
			if idx < len(entities) {
				result = append(result, entities[idx])
			}
		}
	}
	return result
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
