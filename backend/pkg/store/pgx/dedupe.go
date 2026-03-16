package pgx

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	maxDedupeIterations     = 3
	maxParallelDedupeGroups = 2
)

// entityPair represents two potentially duplicate entities
type entityPair struct {
	ID1   string
	Name1 string
	Type1 string
	ID2   string
	Name2 string
	Type2 string
}

// entityWithMeta holds entity data plus DB id and source count
type entityWithMeta struct {
	common.Entity
	DBID        string
	SourceCount int
}

type entityMergeComponent struct {
	CanonicalID   string
	DupeIDs       []string
	CanonicalName string
}

type appliedEntityMergeComponent struct {
	CanonicalID string
	DupeIDs     []string
}

type relationshipState struct {
	ID           string
	SourceID     string
	TargetID     string
	Rank         float64
	RankSum      float64
	RankCount    int
	OriginalRank float64
	Active       bool
}

type relationshipDedupePlan struct {
	RelationshipIDs []string
	CanonicalIDs    []string
	RankIDs         []string
	Ranks           []float64
	DeleteIDs       []string
}

type relationshipDedupePlanner struct {
	states    map[string]*relationshipState
	parent    map[string]string
	deleteIDs map[string]struct{}
}

// DedupeAndMergeEntities finds and merges duplicate entities in the DB.
// Each merge is performed in its own transaction; AI calls happen outside DB transactions.
func (s *GraphDBStorage) DedupeAndMergeEntities(
	ctx context.Context,
	graphID string,
	aiClient ai.GraphAIClient,
	seedEntityIDs []string,
) error {
	projectID := graphID

	// Parallel group processing below assumes s.conn is pool-backed (for example
	// a *pgxpool.Pool), so each query/transaction can use its own connection.
	qtx := pgdb.New(s.conn)

	batchSize := ai.GetDedupeBatchSize()
	seedEntityIDs = slices.Clone(seedEntityIDs)
	slices.Sort(seedEntityIDs)
	seedEntityIDs = slices.Compact(seedEntityIDs)

	var relationshipPlanner *relationshipDedupePlanner

	for iteration := 1; iteration <= maxDedupeIterations; iteration++ {
		pairs, err := s.findSimilarEntityPairs(ctx, qtx, projectID, seedEntityIDs)
		if err != nil {
			return fmt.Errorf("failed to find similar entities: %w", err)
		}
		if len(pairs) == 0 {
			logger.Debug("[Dedupe] No similar entity pairs found", "iteration", iteration)
			break
		}
		if relationshipPlanner == nil {
			relationships, err := qtx.GetProjectRelationships(ctx, projectID)
			if err != nil {
				return fmt.Errorf("failed to load project relationships for dedupe: %w", err)
			}
			relationshipPlanner = newRelationshipDedupePlanner(relationships)
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

		iterationAppliedByGroup := make([][]appliedEntityMergeComponent, len(groups))
		eg, gCtx := errgroup.WithContext(ctx)
		eg.SetLimit(maxParallelDedupeGroups)
		for i, group := range groups {
			if len(group) <= 1 {
				continue
			}
			idx := i
			groupIDs := slices.Clone(group)
			eg.Go(func() error {
				applied, err := s.dedupeEntityGroup(gCtx, projectID, groupIDs, aiClient, iteration)
				if err != nil {
					return fmt.Errorf("group %d merge failed: %w", idx, err)
				}
				iterationAppliedByGroup[idx] = applied
				return nil
			})
		}
		if err := eg.Wait(); err != nil {
			return fmt.Errorf("failed to merge entities: %w", err)
		}

		iterationMerged := false
		iterationApplied := make([]appliedEntityMergeComponent, 0)
		for _, applied := range iterationAppliedByGroup {
			if len(applied) == 0 {
				continue
			}
			iterationMerged = true
			iterationApplied = append(iterationApplied, applied...)
		}

		relationshipPlanner.applyEntityMerges(iterationApplied)
		relationshipPlanner.dedupeIteration()
		plan := relationshipPlanner.buildPlan()
		if err := s.applyRelationshipDedupePlan(ctx, projectID, plan); err != nil {
			return fmt.Errorf("failed to dedupe relationships: %w", err)
		}
		relationshipPlanner.commitPlan(plan)

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
	projectID string,
	seedEntityIDs []string,
) ([]entityPair, error) {
	var (
		raws       []pgdb.FindEntitiesWithSimilarNamesRow
		rawsSeeded []pgdb.FindEntitiesWithSimilarNamesForEntityIDsRow
		err        error
	)
	if len(seedEntityIDs) == 0 {
		raws, err = qtx.FindEntitiesWithSimilarNames(ctx, projectID)
	} else {
		rawsSeeded, err = qtx.FindEntitiesWithSimilarNamesForEntityIDs(ctx, pgdb.FindEntitiesWithSimilarNamesForEntityIDsParams{
			ProjectID: projectID,
			EntityIds: seedEntityIDs,
		})
	}
	if err != nil {
		return nil, err
	}

	if len(seedEntityIDs) == 0 {
		pairs := make([]entityPair, len(raws))
		for i, row := range raws {
			pairs[i] = entityPair{
				ID1:   row.Id1,
				Name1: row.Name1,
				Type1: row.Type1,
				ID2:   row.Id2,
				Name2: row.Name2,
				Type2: row.Type2,
			}
		}
		return pairs, nil
	}

	pairs := make([]entityPair, len(rawsSeeded))
	for i, row := range rawsSeeded {
		pairs[i] = entityPair{
			ID1:   row.Id1,
			Name1: row.Name1,
			Type1: row.Type1,
			ID2:   row.Id2,
			Name2: row.Name2,
			Type2: row.Type2,
		}
	}
	return pairs, nil
}

// buildConnectedComponents groups entity IDs that are transitively similar
// Uses union-find algorithm
func buildConnectedComponents(pairs []entityPair) [][]string {
	parent := make(map[string]string)

	var find func(x string) string
	find = func(x string) string {
		if _, ok := parent[x]; !ok {
			parent[x] = x
		}
		if parent[x] != x {
			parent[x] = find(parent[x])
		}
		return parent[x]
	}

	union := func(x, y string) {
		px, py := find(x), find(y)
		if px != py {
			parent[px] = py
		}
	}

	for _, p := range pairs {
		union(p.ID1, p.ID2)
	}

	components := make(map[string][]string)
	for id := range parent {
		root := find(id)
		components[root] = append(components[root], id)
	}

	result := make([][]string, 0, len(components))
	for _, group := range components {
		if len(group) > 1 {
			sort.Strings(group)
			result = append(result, group)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if len(result[i]) == 0 || len(result[j]) == 0 {
			return len(result[i]) < len(result[j])
		}
		return compareIDStrings(result[i][0], result[j][0]) < 0
	})
	return result
}

// getEntitiesWithMeta fetches entities with their source counts
func (s *GraphDBStorage) getEntitiesWithMeta(
	ctx context.Context,
	qtx *pgdb.Queries,
	projectID string,
	ids []string,
) ([]entityWithMeta, error) {
	entities, err := qtx.GetProjectEntitiesWithSourceCountsByIDs(ctx, pgdb.GetProjectEntitiesWithSourceCountsByIDsParams{
		ProjectID: projectID,
		Ids:       ids,
	})
	if err != nil {
		return nil, err
	}

	result := make([]entityWithMeta, len(entities))
	for i, e := range entities {
		result[i] = entityWithMeta{
			Entity: common.Entity{
				ID:          e.ID,
				Name:        e.Name,
				Type:        e.Type,
				Description: e.Description,
			},
			DBID:        e.ID,
			SourceCount: int(e.SourceCount),
		}
	}
	return result, nil
}

// applyEntityMerges applies the AI dedupe results to merge entities
func (s *GraphDBStorage) applyEntityMerges(
	ctx context.Context,
	projectID string,
	entities []entityWithMeta,
	dupeResponse *ai.DuplicatesResponse,
) ([]appliedEntityMergeComponent, error) {
	if dupeResponse == nil {
		return nil, nil
	}

	plan := planEntityMergeComponents(entities, dupeResponse)
	if len(plan) == 0 {
		return nil, nil
	}

	entityByID := make(map[string]*entityWithMeta, len(entities))
	for i := range entities {
		entityByID[entities[i].DBID] = &entities[i]
	}

	appliedComponents := make([]appliedEntityMergeComponent, 0, len(plan))
	for _, comp := range plan {
		applied, err := s.applyEntityMergeComponent(ctx, projectID, comp, entityByID)
		if err != nil {
			return appliedComponents, err
		}
		if applied != nil {
			appliedComponents = append(appliedComponents, *applied)
		}
	}

	return appliedComponents, nil
}

func planEntityMergeComponents(entities []entityWithMeta, dupeResponse *ai.DuplicatesResponse) []entityMergeComponent {
	if dupeResponse == nil {
		return nil
	}
	if len(entities) == 0 {
		return nil
	}

	byName := make(map[string][]*entityWithMeta)
	byID := make(map[string]*entityWithMeta, len(entities))
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
		ids           []string
		canonicalName string
	}
	resolved := make([]resolvedGroup, 0, len(dupeResponse.Duplicates))
	for _, group := range dupeResponse.Duplicates {
		if len(group.Entities) <= 1 {
			continue
		}

		candidateByID := make(map[string]*entityWithMeta)
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

		idsSet := make(map[string]struct{})
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

		ids := make([]string, 0, len(idsSet))
		for id := range idsSet {
			ids = append(ids, id)
		}
		sort.Strings(ids)

		resolved = append(resolved, resolvedGroup{ids: ids, canonicalName: strings.TrimSpace(group.Name)})
	}

	if len(resolved) == 0 {
		return nil
	}

	parent := make(map[string]string)
	var find func(string) string
	find = func(x string) string {
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
	union := func(x, y string) {
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

	components := make(map[string][]string)
	for id := range parent {
		root := find(id)
		components[root] = append(components[root], id)
	}

	nameCandidates := make(map[string][]string)
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

		canonicalID := ""
		for _, id := range ids {
			e := byID[id]
			if e == nil {
				continue
			}
			if canonicalID == "" {
				canonicalID = id
				continue
			}
			cur := byID[canonicalID]
			if cur == nil {
				canonicalID = id
				continue
			}
			if e.SourceCount > cur.SourceCount || (e.SourceCount == cur.SourceCount && compareIDStrings(id, canonicalID) < 0) {
				canonicalID = id
			}
		}
		if canonicalID == "" {
			continue
		}

		dupeIDs := make([]string, 0, len(ids)-1)
		for _, id := range ids {
			if id == canonicalID {
				continue
			}
			dupeIDs = append(dupeIDs, id)
		}
		if len(dupeIDs) == 0 {
			continue
		}
		sort.Strings(dupeIDs)

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
		return compareIDStrings(plan[i].CanonicalID, plan[j].CanonicalID) < 0
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
	projectID string,
	comp entityMergeComponent,
	entityByID map[string]*entityWithMeta,
) (*appliedEntityMergeComponent, error) {
	if comp.CanonicalID == "" || len(comp.DupeIDs) == 0 {
		return nil, nil
	}

	const maxAttempts = 3
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		applied, err := s.applyEntityMergeComponentOnce(ctx, projectID, comp, entityByID)
		if err == nil {
			return applied, nil
		}
		if attempt == maxAttempts || !isRetryableTxError(err) {
			return nil, err
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt*100) * time.Millisecond):
		}
	}

	return nil, nil
}

func (s *GraphDBStorage) applyEntityMergeComponentOnce(
	ctx context.Context,
	projectID string,
	comp entityMergeComponent,
	entityByID map[string]*entityWithMeta,
) (*appliedEntityMergeComponent, error) {
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	qtx := pgdb.New(tx)

	idsToCheck := make([]string, 0, 1+len(comp.DupeIDs))
	idsToCheck = append(idsToCheck, comp.CanonicalID)
	idsToCheck = append(idsToCheck, comp.DupeIDs...)

	existingRows, err := qtx.GetProjectEntitiesByIDsForUpdate(ctx, pgdb.GetProjectEntitiesByIDsForUpdateParams{
		ProjectID: projectID,
		Ids:       idsToCheck,
	})
	if err != nil {
		return nil, err
	}
	if len(existingRows) <= 1 {
		return nil, nil
	}
	exists := make(map[string]struct{}, len(existingRows))
	for _, r := range existingRows {
		exists[r.ID] = struct{}{}
	}

	canonicalID := comp.CanonicalID
	if _, ok := exists[canonicalID]; !ok {
		canonicalID = ""
		for id := range exists {
			if canonicalID == "" {
				canonicalID = id
				continue
			}
			cur := entityByID[canonicalID]
			cand := entityByID[id]
			if cur == nil || cand == nil {
				if compareIDStrings(id, canonicalID) < 0 {
					canonicalID = id
				}
				continue
			}
			if cand.SourceCount > cur.SourceCount || (cand.SourceCount == cur.SourceCount && compareIDStrings(id, canonicalID) < 0) {
				canonicalID = id
			}
		}
		if canonicalID == "" {
			return nil, nil
		}
	}

	dupeIDs := make([]string, 0, len(comp.DupeIDs))
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
		return nil, nil
	}
	sort.Strings(dupeIDs)

	canonicalName := strings.TrimSpace(comp.CanonicalName)
	if canonicalName != "" {
		err = qtx.UpdateEntityName(ctx, pgdb.UpdateEntityNameParams{
			ID:        canonicalID,
			Name:      canonicalName,
			ProjectID: projectID,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to update canonical name: %w", err)
		}
	}

	err = qtx.TransferEntitySourcesBatch(ctx, pgdb.TransferEntitySourcesBatchParams{
		ProjectID:   projectID,
		CanonicalID: canonicalID,
		EntityIds:   dupeIDs,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to transfer sources: %w", err)
	}

	err = qtx.UpdateRelationshipSourceEntitiesBatch(ctx, pgdb.UpdateRelationshipSourceEntitiesBatchParams{
		CanonicalID: canonicalID,
		ProjectID:   projectID,
		EntityIds:   dupeIDs,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to update relationship sources: %w", err)
	}

	err = qtx.UpdateRelationshipTargetEntitiesBatch(ctx, pgdb.UpdateRelationshipTargetEntitiesBatchParams{
		CanonicalID: canonicalID,
		ProjectID:   projectID,
		EntityIds:   dupeIDs,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to update relationship targets: %w", err)
	}

	err = qtx.DeleteProjectEntitiesByIDs(ctx, pgdb.DeleteProjectEntitiesByIDsParams{
		ProjectID: projectID,
		Ids:       dupeIDs,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to delete duplicate entities: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return &appliedEntityMergeComponent{CanonicalID: canonicalID, DupeIDs: dupeIDs}, nil
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
	projectID string,
	group []string,
	aiClient ai.GraphAIClient,
	iteration int,
) ([]appliedEntityMergeComponent, error) {
	qtx := pgdb.New(s.conn)
	entities, err := s.getEntitiesWithMeta(ctx, qtx, projectID, group)
	if err != nil {
		return nil, fmt.Errorf("failed to get entities: %w", err)
	}
	if len(entities) <= 1 {
		return nil, nil
	}

	batchSize := ai.GetDedupeBatchSize()
	ordered := reorderEntitiesWithMeta(entities, iteration, batchSize)
	appliedComponents := make([]appliedEntityMergeComponent, 0)

	type dedupeChunk struct {
		start          int
		end            int
		commonEntities []common.Entity
	}

	chunks := make([]dedupeChunk, 0, (len(ordered)+batchSize-1)/batchSize)
	for i := 0; i < len(ordered); i += batchSize {
		end := min(i+batchSize, len(ordered))
		chunk := ordered[i:end]
		commonEntities := make([]common.Entity, len(chunk))
		for idx, e := range chunk {
			commonEntities[idx] = e.Entity
		}
		chunks = append(chunks, dedupeChunk{start: i, end: end, commonEntities: commonEntities})
	}

	dupeResponses := make([]*ai.DuplicatesResponse, len(chunks))

	eg, gCtx := errgroup.WithContext(ctx)
	for i := range chunks {
		idx := i
		chunk := chunks[i]
		eg.Go(func() error {
			dupeResponse, err := ai.CallDedupeAI(gCtx, chunk.commonEntities, aiClient, 3)
			if err != nil {
				return fmt.Errorf("AI dedupe failed: %w", err)
			}
			dupeResponses[idx] = dupeResponse
			return nil
		})
	}
	if err := eg.Wait(); err != nil {
		return nil, err
	}

	for i := range chunks {
		dupeResponse := dupeResponses[i]
		if !hasDuplicateGroups(dupeResponse) {
			continue
		}
		chunk := ordered[chunks[i].start:chunks[i].end]
		batchApplied, err := s.applyEntityMerges(ctx, projectID, chunk, dupeResponse)
		if err != nil {
			return nil, err
		}
		if len(batchApplied) > 0 {
			appliedComponents = append(appliedComponents, batchApplied...)
		}
	}

	return appliedComponents, nil
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

func newRelationshipDedupePlanner(rows []pgdb.GetProjectRelationshipsRow) *relationshipDedupePlanner {
	states := make(map[string]*relationshipState, len(rows))
	for _, row := range rows {
		states[row.ID] = &relationshipState{
			ID:           row.ID,
			SourceID:     row.SourceID,
			TargetID:     row.TargetID,
			Rank:         row.Rank,
			RankSum:      row.Rank,
			RankCount:    1,
			OriginalRank: row.Rank,
			Active:       true,
		}
	}
	return &relationshipDedupePlanner{
		states:    states,
		parent:    make(map[string]string),
		deleteIDs: make(map[string]struct{}),
	}
}

func (p *relationshipDedupePlanner) applyEntityMerges(components []appliedEntityMergeComponent) {
	if p == nil || len(components) == 0 {
		return
	}

	remap := make(map[string]string)
	for _, comp := range components {
		for _, dupeID := range comp.DupeIDs {
			remap[dupeID] = comp.CanonicalID
		}
	}
	if len(remap) == 0 {
		return
	}

	for _, state := range p.states {
		if !state.Active {
			continue
		}
		if canonicalID, ok := remap[state.SourceID]; ok {
			state.SourceID = canonicalID
		}
		if canonicalID, ok := remap[state.TargetID]; ok {
			state.TargetID = canonicalID
		}
		if state.SourceID == state.TargetID {
			state.Active = false
			p.deleteIDs[state.ID] = struct{}{}
		}
	}
}

func (p *relationshipDedupePlanner) dedupeIteration() {
	if p == nil {
		return
	}

	byEdge := make(map[string][]*relationshipState)
	for _, state := range p.states {
		if !state.Active {
			continue
		}
		key := relationshipEdgeKey(state.SourceID, state.TargetID)
		byEdge[key] = append(byEdge[key], state)
	}

	for _, group := range byEdge {
		if len(group) <= 1 {
			continue
		}
		sort.Slice(group, func(i, j int) bool {
			return compareIDStrings(group[i].ID, group[j].ID) < 0
		})

		keep := group[0]
		totalRank := 0.0
		totalCount := 0
		for _, state := range group {
			totalRank += state.RankSum
			totalCount += state.RankCount
		}
		keep.RankSum = totalRank
		keep.RankCount = totalCount
		keep.Rank = totalRank / float64(totalCount)

		for _, dupe := range group[1:] {
			dupe.Active = false
			p.parent[dupe.ID] = keep.ID
			p.deleteIDs[dupe.ID] = struct{}{}
		}
	}
}

func (p *relationshipDedupePlanner) buildPlan() relationshipDedupePlan {
	if p == nil {
		return relationshipDedupePlan{}
	}

	deleteSet := make(map[string]struct{}, len(p.parent)+len(p.deleteIDs))
	for relationshipID := range p.parent {
		deleteSet[relationshipID] = struct{}{}
	}
	for relationshipID := range p.deleteIDs {
		deleteSet[relationshipID] = struct{}{}
	}

	deleteIDs := make([]string, 0, len(deleteSet))
	for relationshipID := range deleteSet {
		deleteIDs = append(deleteIDs, relationshipID)
	}
	sort.Strings(deleteIDs)

	relationshipIDs := make([]string, 0, len(deleteIDs))
	canonicalIDs := make([]string, 0, len(deleteIDs))
	for _, relationshipID := range deleteIDs {
		canonicalID := p.resolveCanonicalID(relationshipID)
		if canonicalID == relationshipID {
			continue
		}
		relationshipIDs = append(relationshipIDs, relationshipID)
		canonicalIDs = append(canonicalIDs, canonicalID)
	}

	type rankUpdate struct {
		id   string
		rank float64
	}
	rankUpdates := make([]rankUpdate, 0)
	for _, state := range p.states {
		if !state.Active {
			continue
		}
		if state.Rank == state.OriginalRank {
			continue
		}
		rankUpdates = append(rankUpdates, rankUpdate{id: state.ID, rank: state.Rank})
	}
	sort.Slice(rankUpdates, func(i, j int) bool {
		return compareIDStrings(rankUpdates[i].id, rankUpdates[j].id) < 0
	})
	rankIDs := make([]string, 0, len(rankUpdates))
	ranks := make([]float64, 0, len(rankUpdates))
	for _, update := range rankUpdates {
		rankIDs = append(rankIDs, update.id)
		ranks = append(ranks, update.rank)
	}

	return relationshipDedupePlan{
		RelationshipIDs: relationshipIDs,
		CanonicalIDs:    canonicalIDs,
		RankIDs:         rankIDs,
		Ranks:           ranks,
		DeleteIDs:       deleteIDs,
	}
}

func (p *relationshipDedupePlanner) commitPlan(plan relationshipDedupePlan) {
	if p == nil {
		return
	}

	for _, relationshipID := range plan.DeleteIDs {
		delete(p.states, relationshipID)
	}

	for _, relationshipID := range plan.RankIDs {
		state, ok := p.states[relationshipID]
		if !ok {
			continue
		}
		state.OriginalRank = state.Rank
	}

	p.parent = make(map[string]string)
	p.deleteIDs = make(map[string]struct{})
}

func (p *relationshipDedupePlanner) resolveCanonicalID(relationshipID string) string {
	nextID, ok := p.parent[relationshipID]
	if !ok {
		return relationshipID
	}
	rootID := p.resolveCanonicalID(nextID)
	p.parent[relationshipID] = rootID
	return rootID
}

func relationshipEdgeKey(sourceID, targetID string) string {
	if sourceID > targetID {
		sourceID, targetID = targetID, sourceID
	}
	return sourceID + "|" + targetID
}

func compareIDStrings(left, right string) int {
	leftInt, leftErr := strconv.ParseInt(left, 10, 64)
	rightInt, rightErr := strconv.ParseInt(right, 10, 64)
	if leftErr == nil && rightErr == nil {
		switch {
		case leftInt < rightInt:
			return -1
		case leftInt > rightInt:
			return 1
		default:
			return 0
		}
	}
	return strings.Compare(left, right)
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

func (s *GraphDBStorage) applyRelationshipDedupePlan(
	ctx context.Context,
	projectID string,
	plan relationshipDedupePlan,
) error {
	if len(plan.RelationshipIDs) == 0 && len(plan.RankIDs) == 0 && len(plan.DeleteIDs) == 0 {
		return nil
	}

	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin relationship dedupe tx: %w", err)
	}
	defer tx.Rollback(ctx)
	txq := pgdb.New(tx)

	if len(plan.RelationshipIDs) > 0 {
		err := txq.TransferRelationshipSourcesBatchByMappings(ctx, pgdb.TransferRelationshipSourcesBatchByMappingsParams{
			ProjectID:       projectID,
			RelationshipIds: plan.RelationshipIDs,
			CanonicalIds:    plan.CanonicalIDs,
		})
		if err != nil {
			return fmt.Errorf("failed to transfer relationship sources: %w", err)
		}
	}

	if len(plan.RankIDs) > 0 {
		err := txq.UpdateProjectRelationshipRanksByIDs(ctx, pgdb.UpdateProjectRelationshipRanksByIDsParams{
			ProjectID: projectID,
			Ids:       plan.RankIDs,
			Ranks:     plan.Ranks,
		})
		if err != nil {
			return fmt.Errorf("failed to update relationship ranks: %w", err)
		}
	}

	if len(plan.DeleteIDs) > 0 {
		err := txq.DeleteProjectRelationshipsByIDs(ctx, pgdb.DeleteProjectRelationshipsByIDsParams{
			ProjectID: projectID,
			Ids:       plan.DeleteIDs,
		})
		if err != nil {
			return fmt.Errorf("failed to delete duplicate relationships: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit relationship dedupe tx: %w", err)
	}

	return nil
}
