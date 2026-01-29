package pgx

import (
	"slices"
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/jackc/pgx/v5/pgconn"
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

type entityMergeComponent struct {
	CanonicalID   int64
	DupeIDs       []int64
	CanonicalName string
}

// DedupeAndMergeEntities finds and merges duplicate entities in the DB.
// Each merge is performed in its own transaction; AI calls happen outside DB transactions.
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
	projectID int64,
	entities []entityWithMeta,
	dupeResponse *ai.DuplicatesResponse,
) (bool, error) {
	merged := false
	if dupeResponse == nil {
		return false, nil
	}

	plan := planEntityMergeComponents(entities, dupeResponse)
	if len(plan) == 0 {
		return false, nil
	}

	entityByID := make(map[int64]*entityWithMeta, len(entities))
	for i := range entities {
		entityByID[entities[i].DBID] = &entities[i]
	}

	for _, comp := range plan {
		applied, err := s.applyEntityMergeComponent(ctx, projectID, comp, entityByID)
		if err != nil {
			return merged, err
		}
		if applied {
			merged = true
		}
	}

	return merged, nil
}

func planEntityMergeComponents(entities []entityWithMeta, dupeResponse *ai.DuplicatesResponse) []entityMergeComponent {
	if dupeResponse == nil {
		return nil
	}
	if len(entities) == 0 {
		return nil
	}

	byName := make(map[string][]*entityWithMeta)
	byID := make(map[int64]*entityWithMeta, len(entities))
	for i := range entities {
		e := &entities[i]
		byID[e.DBID] = e
		nameKey := normalizeDedupeKey(e.Name)
		if nameKey == "" {
			continue
		}
		byName[nameKey] = append(byName[nameKey], e)
	}

	type resolvedGroup struct {
		ids           []int64
		canonicalName string
	}
	resolved := make([]resolvedGroup, 0, len(dupeResponse.Duplicates))
	for _, group := range dupeResponse.Duplicates {
		if len(group.Entities) <= 1 {
			continue
		}

		candidateByID := make(map[int64]*entityWithMeta)
		for _, name := range group.Entities {
			nameKey := normalizeDedupeKey(name)
			if nameKey == "" {
				continue
			}
			for _, e := range byName[nameKey] {
				candidateByID[e.DBID] = e
			}
		}
		if len(candidateByID) <= 1 {
			continue
		}

		candidates := make([]*entityWithMeta, 0, len(candidateByID))
		for _, e := range candidateByID {
			candidates = append(candidates, e)
		}

		groupType := selectGroupTypeBySources(candidates)
		if groupType == "" {
			continue
		}

		idsSet := make(map[int64]struct{})
		for _, e := range candidates {
			if e == nil {
				continue
			}
			if e.Type != groupType {
				continue
			}
			idsSet[e.DBID] = struct{}{}
		}
		if len(idsSet) <= 1 {
			continue
		}

		ids := make([]int64, 0, len(idsSet))
		for id := range idsSet {
			ids = append(ids, id)
		}
		slices.Sort(ids)

		resolved = append(resolved, resolvedGroup{ids: ids, canonicalName: strings.TrimSpace(group.Name)})
	}

	if len(resolved) == 0 {
		return nil
	}

	// Union-find on entity DB IDs to merge overlapping groups.
	parent := make(map[int64]int64)
	var find func(int64) int64
	find = func(x int64) int64 {
		p, ok := parent[x]
		if !ok {
			parent[x] = x
			return x
		}
		if p != x {
			parent[x] = find(p)
		}
		return parent[x]
	}
	union := func(x, y int64) {
		px, py := find(x), find(y)
		if px != py {
			parent[px] = py
		}
	}

	for _, g := range resolved {
		if len(g.ids) == 0 {
			continue
		}
		first := g.ids[0]
		for _, id := range g.ids {
			union(first, id)
		}
	}

	components := make(map[int64][]int64)
	for id := range parent {
		root := find(id)
		components[root] = append(components[root], id)
	}

	nameCandidates := make(map[int64][]string)
	for _, g := range resolved {
		if len(g.ids) == 0 {
			continue
		}
		if g.canonicalName == "" {
			continue
		}
		root := find(g.ids[0])
		nameCandidates[root] = append(nameCandidates[root], g.canonicalName)
	}

	plan := make([]entityMergeComponent, 0, len(components))
	for root, ids := range components {
		if len(ids) <= 1 {
			continue
		}
		slices.Sort(ids)

		canonicalID := int64(0)
		for _, id := range ids {
			e := byID[id]
			if e == nil {
				continue
			}
			if canonicalID == 0 {
				canonicalID = id
				continue
			}
			cur := byID[canonicalID]
			if cur == nil {
				canonicalID = id
				continue
			}
			if e.SourceCount > cur.SourceCount || (e.SourceCount == cur.SourceCount && id < canonicalID) {
				canonicalID = id
			}
		}
		if canonicalID == 0 {
			continue
		}

		dupeIDs := make([]int64, 0, len(ids)-1)
		for _, id := range ids {
			if id == canonicalID {
				continue
			}
			dupeIDs = append(dupeIDs, id)
		}
		if len(dupeIDs) == 0 {
			continue
		}
		slices.Sort(dupeIDs)

		fallbackName := byID[canonicalID].Name
		canonicalName := chooseCanonicalName(nameCandidates[root], fallbackName)

		plan = append(plan, entityMergeComponent{
			CanonicalID:   canonicalID,
			DupeIDs:       dupeIDs,
			CanonicalName: canonicalName,
		})
	}

	sort.Slice(plan, func(i, j int) bool {
		if plan[i].CanonicalID == plan[j].CanonicalID {
			return len(plan[i].DupeIDs) > len(plan[j].DupeIDs)
		}
		return plan[i].CanonicalID < plan[j].CanonicalID
	})

	return plan
}

func chooseCanonicalName(candidates []string, fallback string) string {
	best := ""
	bestLen := -1
	seen := make(map[string]struct{})

	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if _, ok := seen[c]; ok {
			continue
		}
		seen[c] = struct{}{}
		cl := len(c)
		if cl > bestLen || (cl == bestLen && (best == "" || c < best)) {
			best = c
			bestLen = cl
		}
	}

	if best != "" {
		return best
	}
	return strings.TrimSpace(fallback)
}

func (s *GraphDBStorage) applyEntityMergeComponent(
	ctx context.Context,
	projectID int64,
	comp entityMergeComponent,
	entityByID map[int64]*entityWithMeta,
) (bool, error) {
	if comp.CanonicalID == 0 || len(comp.DupeIDs) == 0 {
		return false, nil
	}

	const maxAttempts = 3
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return false, err
		}

		applied, err := s.applyEntityMergeComponentOnce(ctx, projectID, comp, entityByID)
		if err == nil {
			return applied, nil
		}
		if attempt == maxAttempts || !isRetryableTxError(err) {
			return false, err
		}

		// small backoff before retrying
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(time.Duration(attempt*100) * time.Millisecond):
		}
	}

	return false, nil
}

func (s *GraphDBStorage) applyEntityMergeComponentOnce(
	ctx context.Context,
	projectID int64,
	comp entityMergeComponent,
	entityByID map[int64]*entityWithMeta,
) (bool, error) {
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	qtx := pgdb.New(tx)

	idsToCheck := make([]int64, 0, 1+len(comp.DupeIDs))
	idsToCheck = append(idsToCheck, comp.CanonicalID)
	idsToCheck = append(idsToCheck, comp.DupeIDs...)

	existingRows, err := qtx.GetProjectEntitiesByIDs(ctx, idsToCheck)
	if err != nil {
		return false, err
	}
	if len(existingRows) <= 1 {
		return false, nil
	}
	exists := make(map[int64]pgdb.GetProjectEntitiesByIDsRow, len(existingRows))
	for _, r := range existingRows {
		exists[r.ID] = r
	}

	canonicalID := comp.CanonicalID
	if _, ok := exists[canonicalID]; !ok {
		// canonical disappeared; pick a new canonical deterministically from remaining IDs
		canonicalID = 0
		for id := range exists {
			if canonicalID == 0 {
				canonicalID = id
				continue
			}
			cur := entityByID[canonicalID]
			cand := entityByID[id]
			if cur == nil || cand == nil {
				if id < canonicalID {
					canonicalID = id
				}
				continue
			}
			if cand.SourceCount > cur.SourceCount || (cand.SourceCount == cur.SourceCount && id < canonicalID) {
				canonicalID = id
			}
		}
		if canonicalID == 0 {
			return false, nil
		}
	}

	dupeIDs := make([]int64, 0, len(comp.DupeIDs))
	for _, id := range comp.DupeIDs {
		if id == canonicalID {
			continue
		}
		if _, ok := exists[id]; !ok {
			continue
		}
		dupeIDs = append(dupeIDs, id)
	}
	if len(dupeIDs) == 0 {
		return false, nil
	}
	slices.Sort(dupeIDs)

	canonicalName := strings.TrimSpace(comp.CanonicalName)
	if canonicalName != "" {
		err = qtx.UpdateEntityName(ctx, pgdb.UpdateEntityNameParams{
			ID:   canonicalID,
			Name: canonicalName,
		})
		if err != nil {
			return false, fmt.Errorf("failed to update canonical name: %w", err)
		}
	}

	for _, dupeID := range dupeIDs {
		err := qtx.TransferEntitySources(ctx, pgdb.TransferEntitySourcesParams{
			EntityID:   dupeID,
			EntityID_2: canonicalID,
		})
		if err != nil {
			return false, fmt.Errorf("failed to transfer sources: %w", err)
		}

		err = qtx.UpdateRelationshipSourceEntity(ctx, pgdb.UpdateRelationshipSourceEntityParams{
			SourceID:   dupeID,
			SourceID_2: canonicalID,
			ProjectID:  projectID,
		})
		if err != nil {
			return false, fmt.Errorf("failed to update relationship sources: %w", err)
		}

		err = qtx.UpdateRelationshipTargetEntity(ctx, pgdb.UpdateRelationshipTargetEntityParams{
			TargetID:   dupeID,
			TargetID_2: canonicalID,
			ProjectID:  projectID,
		})
		if err != nil {
			return false, fmt.Errorf("failed to update relationship targets: %w", err)
		}

		err = qtx.DeleteProjectEntity(ctx, dupeID)
		if err != nil {
			return false, fmt.Errorf("failed to delete duplicate entity: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return false, err
	}

	return true, nil
}

func isRetryableTxError(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "40001", "40P01":
			return true
		}
	}
	return false
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

		batchMerged, err := s.applyEntityMerges(ctx, projectID, chunk, dupeResponse)
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
