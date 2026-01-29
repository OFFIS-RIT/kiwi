package pgx

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

const maxDedupeIterations = 3

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

	qtx := pgdb.New(s.conn)

	batchSize := ai.GetDedupeBatchSize()

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
		multiBatch := false
		for _, group := range groups {
			if len(group) > batchSize {
				multiBatch = true
				break
			}
		}

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

		if !multiBatch {
			logger.Debug("[Dedupe] All groups fit in a single batch; stopping iterations", "iteration", iteration)
			break
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

	return nil
}

// findSimilarEntityPairs uses pg_trgm to find entities with similar names
func (s *GraphDBStorage) findSimilarEntityPairs(
	ctx context.Context,
	qtx *pgdb.Queries,
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

	for _, p := range pairs {
		union(p.ID1, p.ID2)
	}

	components := make(map[int64][]int64)
	for id := range parent {
		root := find(id)
		components[root] = append(components[root], id)
	}

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
	qtx *pgdb.Queries,
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
	qtx *pgdb.Queries,
	projectID int64,
	entities []entityWithMeta,
	dupeResponse *ai.DuplicatesResponse,
) (bool, error) {
	merged := false
	entityByName := make(map[string][]*entityWithMeta)
	for i := range entities {
		key := normalizeDedupeKey(entities[i].Name)
		if key == "" {
			continue
		}
		entityByName[key] = append(entityByName[key], &entities[i])
	}

	for _, group := range dupeResponse.Duplicates {
		if len(group.Entities) <= 1 {
			continue
		}

		entitiesByID := make(map[int64]*entityWithMeta)
		for _, name := range group.Entities {
			key := normalizeDedupeKey(name)
			if key == "" {
				continue
			}
			if matches, ok := entityByName[key]; ok {
				for _, e := range matches {
					entitiesByID[e.DBID] = e
				}
			}
		}
		if len(entitiesByID) <= 1 {
			continue
		}

		groupEntities := make([]*entityWithMeta, 0, len(entitiesByID))
		for _, e := range entitiesByID {
			groupEntities = append(groupEntities, e)
		}

		groupType := selectGroupTypeBySources(groupEntities)
		filtered := groupEntities[:0]
		for _, e := range groupEntities {
			if e.Type == groupType {
				filtered = append(filtered, e)
			}
		}
		groupEntities = filtered
		if len(groupEntities) <= 1 {
			continue
		}

		canonical := groupEntities[0]
		for _, e := range groupEntities[1:] {
			if e.SourceCount > canonical.SourceCount {
				canonical = e
			}
		}

		err := qtx.UpdateEntityName(ctx, pgdb.UpdateEntityNameParams{
			ID:   canonical.DBID,
			Name: group.Name,
		})
		if err != nil {
			return merged, fmt.Errorf("failed to update canonical name: %w", err)
		}

		for _, dupe := range groupEntities {
			if dupe.DBID == canonical.DBID {
				continue
			}

			err := qtx.TransferEntitySources(ctx, pgdb.TransferEntitySourcesParams{
				EntityID:   dupe.DBID,
				EntityID_2: canonical.DBID,
			})
			if err != nil {
				return merged, fmt.Errorf("failed to transfer sources: %w", err)
			}

			err = qtx.UpdateRelationshipSourceEntity(ctx, pgdb.UpdateRelationshipSourceEntityParams{
				SourceID:   dupe.DBID,
				SourceID_2: canonical.DBID,
				ProjectID:  projectID,
			})
			if err != nil {
				return merged, fmt.Errorf("failed to update relationship sources: %w", err)
			}

			err = qtx.UpdateRelationshipTargetEntity(ctx, pgdb.UpdateRelationshipTargetEntityParams{
				TargetID:   dupe.DBID,
				TargetID_2: canonical.DBID,
				ProjectID:  projectID,
			})
			if err != nil {
				return merged, fmt.Errorf("failed to update relationship targets: %w", err)
			}

			err = qtx.DeleteProjectEntity(ctx, dupe.DBID)
			if err != nil {
				return merged, fmt.Errorf("failed to delete duplicate entity: %w", err)
			}
			merged = true
		}
	}

	return merged, nil
}

func (s *GraphDBStorage) dedupeEntityGroup(
	ctx context.Context,
	qtx *pgdb.Queries,
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
		end := min(i+batchSize, len(ordered))
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

		batchMerged, err := s.applyEntityMerges(ctx, qtx, projectID, chunk, dupeResponse)
		if err != nil {
			return false, err
		}
		if batchMerged {
			merged = true
		}
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
			left := normalizeDedupeKeyWithType(reordered[i].Name, reordered[i].Type)
			right := normalizeDedupeKeyWithType(reordered[j].Name, reordered[j].Type)
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
	for i := range batchSize {
		for batch := range batchCount {
			idx := batch*batchSize + i
			if idx < len(entities) {
				result = append(result, entities[idx])
			}
		}
	}
	return result
}

func normalizeDedupeKey(value string) string {
	normalized := ai.NormalizeDedupeValue(value)
	if normalized == "" {
		return ""
	}
	return strings.ToUpper(normalized)
}

func normalizeDedupeKeyWithType(name, typ string) string {
	return normalizeDedupeKey(name) + "|" + normalizeDedupeKey(typ)
}

func selectGroupTypeBySources(entities []*entityWithMeta) string {
	if len(entities) == 0 {
		return ""
	}

	typeStats := make(map[string]struct {
		sources int
		count   int
	})

	for _, entity := range entities {
		stats := typeStats[entity.Type]
		stats.sources += entity.SourceCount
		stats.count++
		typeStats[entity.Type] = stats
	}

	bestType := ""
	bestSources := -1
	bestCount := -1
	for typ, stats := range typeStats {
		if stats.sources > bestSources ||
			(stats.sources == bestSources && stats.count > bestCount) ||
			(stats.sources == bestSources && stats.count == bestCount && (bestType == "" || typ < bestType)) {
			bestType = typ
			bestSources = stats.sources
			bestCount = stats.count
		}
	}

	return bestType
}

// dedupeRelationships merges duplicate relationships (same source-target pair)
func (s *GraphDBStorage) dedupeRelationships(
	ctx context.Context,
	qtx *pgdb.Queries,
	projectID int64,
) error {
	dupePairs, err := qtx.FindDuplicateRelationships(ctx, projectID)
	if err != nil {
		return err
	}

	deleted := make(map[int64]bool)

	for _, pair := range dupePairs {
		if deleted[pair.Id1] || deleted[pair.Id2] {
			continue
		}

		err := qtx.TransferRelationshipSources(ctx, pgdb.TransferRelationshipSourcesParams{
			RelationshipID:   pair.Id2,
			RelationshipID_2: pair.Id1,
		})
		if err != nil {
			return fmt.Errorf("failed to transfer relationship sources: %w", err)
		}

		newRank := (pair.Rank1 + pair.Rank2) / 2
		err = qtx.UpdateRelationshipRank(ctx, pgdb.UpdateRelationshipRankParams{
			Rank: newRank,
			ID:   pair.Id1,
		})
		if err != nil {
			return fmt.Errorf("failed to update relationship rank: %w", err)
		}

		err = qtx.DeleteProjectRelationship(ctx, pair.Id2)
		if err != nil {
			return fmt.Errorf("failed to delete duplicate relationship: %w", err)
		}

		deleted[pair.Id2] = true
	}

	return nil
}
