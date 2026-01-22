package graph

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	_ "github.com/invopop/jsonschema"
)

const maxDedupeIterations = 100

func (g *GraphClient) callDedupeAI(
	ctx context.Context,
	entities []common.Entity,
	aiClient ai.GraphAIClient,
) (*ai.DuplicatesResponse, error) {
	return ai.CallDedupeAI(ctx, entities, aiClient, g.maxRetries)
}

func (g *GraphClient) dedupeEntitiesAndRelations(
	ctx context.Context,
	entities []common.Entity,
	relations []common.Relationship,
	aiClient ai.GraphAIClient,
) ([]common.Entity, []common.Relationship, error) {
	return g.dedupeEntitiesStrict(ctx, entities, relations, aiClient)
}

func (g *GraphClient) dedupeEntitiesStrict(
	ctx context.Context,
	entities []common.Entity,
	relations []common.Relationship,
	aiClient ai.GraphAIClient,
) ([]common.Entity, []common.Relationship, error) {
	if len(entities) == 0 {
		return entities, relations, nil
	}

	batchSize := ai.GetDedupeBatchSize()
	dedupedEntities := entities
	dedupedRelations := relations
	var lastIterationHadDuplicates bool

	for iteration := 1; iteration <= maxDedupeIterations; iteration++ {
		prevCount := len(dedupedEntities)
		orderedEntities := reorderEntitiesForIteration(dedupedEntities, iteration, batchSize)

		var hadDuplicates bool
		var err error
		if len(orderedEntities) <= batchSize {
			logger.Debug("[Dedupe] Deduplicating entities in a single batch", "count", len(orderedEntities), "iteration", iteration)
			dedupedEntities, dedupedRelations, hadDuplicates, err = g.dedupeEntitiesSingleBatchWithMeta(ctx, orderedEntities, dedupedRelations, aiClient)
		} else {
			batchCount := (len(orderedEntities) + batchSize - 1) / batchSize
			logger.Debug("[Dedupe] Deduplicating entities in batches", "count", len(orderedEntities), "batches", batchCount, "iteration", iteration)
			dedupedEntities, dedupedRelations, hadDuplicates, err = g.dedupeEntitiesInBatchesOnce(ctx, orderedEntities, dedupedRelations, aiClient)
		}
		if err != nil {
			return nil, nil, err
		}

		lastIterationHadDuplicates = hadDuplicates
		logger.Debug("[Dedupe] Iteration completed", "iteration", iteration, "count", len(dedupedEntities), "duplicates", hadDuplicates)

		if !hadDuplicates || len(dedupedEntities) == prevCount {
			if iteration == maxDedupeIterations && hadDuplicates {
				logger.Warn("[Dedupe] Max iterations reached with remaining duplicates", "count", len(dedupedEntities), "iteration", iteration)
			}
			break
		}

		if iteration == maxDedupeIterations {
			logger.Warn("[Dedupe] Max iterations reached before convergence", "count", len(dedupedEntities), "iteration", iteration)
			break
		}
	}

	if lastIterationHadDuplicates {
		logger.Debug("[Dedupe] Deduplication finished with possible remaining duplicates", "count", len(dedupedEntities))
	}

	return dedupedEntities, dedupedRelations, nil
}

func (g *GraphClient) dedupeEntitiesSingleBatchWithMeta(
	ctx context.Context,
	entities []common.Entity,
	relations []common.Relationship,
	aiClient ai.GraphAIClient,
) ([]common.Entity, []common.Relationship, bool, error) {
	res, err := g.callDedupeAI(ctx, entities, aiClient)
	if err != nil {
		return nil, nil, false, err
	}

	if !hasDuplicateGroups(res) {
		return entities, relations, false, nil
	}

	dedupedEntities, dedupedRelations, err := g.applyDeduplication(entities, relations, res)
	if err != nil {
		return nil, nil, false, err
	}
	return dedupedEntities, dedupedRelations, true, nil
}

func (g *GraphClient) dedupeEntitiesInBatchesOnce(
	ctx context.Context,
	entities []common.Entity,
	relations []common.Relationship,
	aiClient ai.GraphAIClient,
) ([]common.Entity, []common.Relationship, bool, error) {
	var allDedupedEntities []common.Entity
	var allDedupedRelations []common.Relationship
	batchSize := ai.GetDedupeBatchSize()
	duplicatesFound := false

	for i := 0; i < len(entities); i += batchSize {
		end := util.Min(i+batchSize, len(entities))

		batchEntities := entities[i:end]
		batchRelations := g.getRelationsForEntities(batchEntities, relations)

		dedupedE, dedupedR, hadDuplicates, err := g.dedupeEntitiesSingleBatchWithMeta(ctx, batchEntities, batchRelations, aiClient)
		if err != nil {
			return nil, nil, false, fmt.Errorf("batch %d failed: %w", i/batchSize+1, err)
		}
		if hadDuplicates {
			duplicatesFound = true
		}

		allDedupedEntities = append(allDedupedEntities, dedupedE...)
		allDedupedRelations = append(allDedupedRelations, dedupedR...)
	}

	return allDedupedEntities, allDedupedRelations, duplicatesFound, nil
}

func hasDuplicateGroups(res *ai.DuplicatesResponse) bool {
	for _, group := range res.Duplicates {
		if len(group.Entities) > 1 {
			return true
		}
	}
	return false
}

func reorderEntitiesForIteration(entities []common.Entity, iteration int, batchSize int) []common.Entity {
	reordered := make([]common.Entity, len(entities))
	copy(reordered, entities)

	switch iteration % 3 {
	case 1:
		return reordered
	case 2:
		return interleaveEntities(reordered, batchSize)
	default:
		sort.Slice(reordered, func(i, j int) bool {
			left := strings.ToUpper(strings.TrimSpace(reordered[i].Name)) + "|" + strings.ToUpper(strings.TrimSpace(reordered[i].Type))
			right := strings.ToUpper(strings.TrimSpace(reordered[j].Name)) + "|" + strings.ToUpper(strings.TrimSpace(reordered[j].Type))
			return left < right
		})
		return reordered
	}
}

func interleaveEntities(entities []common.Entity, batchSize int) []common.Entity {
	if batchSize <= 0 {
		return entities
	}

	batchCount := (len(entities) + batchSize - 1) / batchSize
	result := make([]common.Entity, 0, len(entities))
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

func (g *GraphClient) getRelationsForEntities(
	entities []common.Entity,
	relations []common.Relationship,
) []common.Relationship {
	normalizeKey := func(name, typ string) string {
		return strings.ToUpper(strings.TrimSpace(name)) + "|" + strings.ToUpper(strings.TrimSpace(typ))
	}

	entitySet := make(map[string]bool)
	for _, e := range entities {
		entitySet[normalizeKey(e.Name, e.Type)] = true
	}

	var result []common.Relationship
	for _, rel := range relations {
		if rel.Source == nil || rel.Target == nil {
			continue
		}
		srcKey := normalizeKey(rel.Source.Name, rel.Source.Type)
		tgtKey := normalizeKey(rel.Target.Name, rel.Target.Type)
		if entitySet[srcKey] && entitySet[tgtKey] {
			result = append(result, rel)
		}
	}
	return result
}

func (g *GraphClient) applyDeduplication(
	entities []common.Entity,
	relations []common.Relationship,
	res *ai.DuplicatesResponse,
) ([]common.Entity, []common.Relationship, error) {
	normalizeKey := func(name, typ string) string {
		return strings.ToUpper(strings.TrimSpace(name)) + "|" + strings.ToUpper(strings.TrimSpace(typ))
	}

	entityIndex := make(map[string]int)
	for i := range entities {
		key := normalizeKey(entities[i].Name, entities[i].Type)
		entityIndex[key] = i
	}

	oldToCanonicalIndex := make(map[string]int)
	canonicalsIndex := make(map[string]int)

	for _, group := range res.Duplicates {
		if len(group.Entities) == 0 {
			continue
		}

		groupIndices := make([]int, 0)
		var groupType string
		for _, name := range group.Entities {
			prefix := normalizeKey(name, "")
			for key, idx := range entityIndex {
				if strings.HasPrefix(key, prefix) {
					if groupType == "" {
						groupType = entities[idx].Type
					}
					if entities[idx].Type == groupType {
						groupIndices = append(groupIndices, idx)
					}
				}
			}
		}

		if len(groupIndices) == 0 {
			continue
		}

		canonicalIdx := groupIndices[0]
		for _, i := range groupIndices[1:] {
			if len(entities[i].Sources) > len(entities[canonicalIdx].Sources) {
				canonicalIdx = i
			} else if len(entities[i].Sources) == len(entities[canonicalIdx].Sources) && len(entities[i].Description) > len(entities[canonicalIdx].Description) {
				canonicalIdx = i
			}
		}

		allSources := make([]common.Source, 0)
		sourceIDs := make(map[string]bool)
		for _, i := range groupIndices {
			for _, src := range entities[i].Sources {
				if !sourceIDs[src.ID] {
					sourceIDs[src.ID] = true
					allSources = append(allSources, src)
				}
			}
		}

		bestDescription := entities[canonicalIdx].Description
		for _, i := range groupIndices {
			if len(entities[i].Description) > len(bestDescription) {
				bestDescription = entities[i].Description
			}
		}

		entities[canonicalIdx].Name = group.Name
		entities[canonicalIdx].Sources = allSources
		entities[canonicalIdx].Description = bestDescription

		canonKey := normalizeKey(entities[canonicalIdx].Name, entities[canonicalIdx].Type)
		canonicalsIndex[canonKey] = canonicalIdx

		for _, i := range groupIndices {
			key := normalizeKey(entities[i].Name, entities[i].Type)
			oldToCanonicalIndex[key] = canonicalIdx
		}
	}

	for i := range entities {
		key := normalizeKey(entities[i].Name, entities[i].Type)
		if _, alreadyMapped := oldToCanonicalIndex[key]; alreadyMapped {
			continue
		}

		if canonicalIdx, collision := canonicalsIndex[key]; collision {
			existing := &entities[canonicalIdx]
			for _, src := range entities[i].Sources {
				found := false
				for _, existingSrc := range existing.Sources {
					if existingSrc.ID == src.ID {
						found = true
						break
					}
				}
				if !found {
					existing.Sources = append(existing.Sources, src)
				}
			}

			if len(entities[i].Description) > len(existing.Description) {
				existing.Description = entities[i].Description
			}

			oldToCanonicalIndex[key] = canonicalIdx
		}
	}

	dedupedKeyToOldIndex := make(map[string]int)
	for i := range entities {
		key := normalizeKey(entities[i].Name, entities[i].Type)
		if canonicalIdx, ok := oldToCanonicalIndex[key]; ok {
			canonKey := normalizeKey(entities[canonicalIdx].Name, entities[canonicalIdx].Type)
			dedupedKeyToOldIndex[canonKey] = canonicalIdx
		} else {
			dedupedKeyToOldIndex[key] = i
		}
	}

	dedupedEntities := make([]common.Entity, 0, len(dedupedKeyToOldIndex))
	dedupedKeyToNewIndex := make(map[string]int)
	for key, oldIdx := range dedupedKeyToOldIndex {
		newIdx := len(dedupedEntities)
		dedupedEntities = append(dedupedEntities, entities[oldIdx])
		dedupedKeyToNewIndex[key] = newIdx
	}

	resolveIndex := func(name, typ string) (int, bool) {
		key := normalizeKey(name, typ)
		if canonicalIdx, ok := oldToCanonicalIndex[key]; ok {
			canonKey := normalizeKey(entities[canonicalIdx].Name, entities[canonicalIdx].Type)
			if newIdx, ok2 := dedupedKeyToNewIndex[canonKey]; ok2 {
				return newIdx, true
			}
		}
		if newIdx, ok := dedupedKeyToNewIndex[key]; ok {
			return newIdx, true
		}
		return -1, false
	}

	remappedRelations := make([]common.Relationship, 0)
	for _, rel := range relations {
		if rel.Source == nil || rel.Target == nil {
			continue
		}

		srcIdx, okS := resolveIndex(rel.Source.Name, rel.Source.Type)
		tgtIdx, okT := resolveIndex(rel.Target.Name, rel.Target.Type)
		if !okS || !okT {
			continue
		}
		if srcIdx == tgtIdx {
			continue
		}

		rel.Source = &dedupedEntities[srcIdx]
		rel.Target = &dedupedEntities[tgtIdx]
		remappedRelations = append(remappedRelations, rel)
	}

	undirectedKey := func(a, b string) string {
		if a < b {
			return a + "|" + b
		}
		return b + "|" + a
	}

	relMap := make(map[string]*common.Relationship)
	for _, rel := range remappedRelations {
		key := undirectedKey(
			normalizeKey(rel.Source.Name, rel.Source.Type),
			normalizeKey(rel.Target.Name, rel.Target.Type),
		)

		if existing, ok := relMap[key]; ok {
			existingSourceIDs := make(map[string]bool)
			for _, src := range existing.Sources {
				existingSourceIDs[src.ID] = true
			}
			for _, src := range rel.Sources {
				if !existingSourceIDs[src.ID] {
					existing.Sources = append(existing.Sources, src)
				}
			}
			existing.Strength = (existing.Strength + rel.Strength) / 2
		} else {
			relCopy := rel
			relMap[key] = &relCopy
		}
	}

	dedupedRelations := make([]common.Relationship, 0, len(relMap))
	for _, rel := range relMap {
		dedupedRelations = append(dedupedRelations, *rel)
	}

	return dedupedEntities, dedupedRelations, nil
}
