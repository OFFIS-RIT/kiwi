package graph

import (
	"context"
	"fmt"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"strings"

	_ "github.com/invopop/jsonschema"
)

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
	entityCount := len(entities)
	batchSize := ai.GetDedupeBatchSize()

	if entityCount <= batchSize {
		logger.Debug("[Dedupe] Deduplicating entities in a single batch", "count", entityCount)
		return g.dedupeEntitiesSingleBatch(ctx, entities, relations, aiClient)
	}

	batchCount := (entityCount + batchSize - 1) / batchSize
	logger.Debug("[Dedupe] Deduplicating entities in batches", "count", entityCount, "batches", batchCount)
	return g.dedupeEntitiesInBatches(ctx, entities, relations, aiClient)
}

func (g *GraphClient) dedupeEntitiesSingleBatch(
	ctx context.Context,
	entities []common.Entity,
	relations []common.Relationship,
	aiClient ai.GraphAIClient,
) ([]common.Entity, []common.Relationship, error) {
	res, err := g.callDedupeAI(ctx, entities, aiClient)
	if err != nil {
		return nil, nil, err
	}

	return g.applyDeduplication(entities, relations, res)
}

func (g *GraphClient) dedupeEntitiesInBatches(
	ctx context.Context,
	entities []common.Entity,
	relations []common.Relationship,
	aiClient ai.GraphAIClient,
) ([]common.Entity, []common.Relationship, error) {
	var allDedupedEntities []common.Entity
	var allDedupedRelations []common.Relationship
	batchSize := ai.GetDedupeBatchSize()

	for i := 0; i < len(entities); i += batchSize {
		end := min(i+batchSize, len(entities))

		batchEntities := entities[i:end]
		batchRelations := g.getRelationsForEntities(batchEntities, relations)

		dedupedE, dedupedR, err := g.dedupeEntitiesSingleBatch(ctx, batchEntities, batchRelations, aiClient)
		if err != nil {
			return nil, nil, fmt.Errorf("batch %d failed: %w", i/batchSize+1, err)
		}

		allDedupedEntities = append(allDedupedEntities, dedupedE...)
		allDedupedRelations = append(allDedupedRelations, dedupedR...)
	}

	if len(allDedupedEntities) <= batchSize {
		logger.Debug("[Dedupe] Performing cross-batch deduplication", "count", len(allDedupedEntities))
		return g.dedupeEntitiesSingleBatch(ctx, allDedupedEntities, allDedupedRelations, aiClient)
	}

	// NOTE: When entity count exceeds batch size after initial deduplication,
	// cross-batch deduplication is skipped. Duplicates spanning batches may remain.
	// This is a performance tradeoff to avoid excessive AI calls.
	logger.Warn("[Dedupe] Cross-batch deduplication skipped; entity count still exceeds batch size", "count", len(allDedupedEntities))
	return allDedupedEntities, allDedupedRelations, nil
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
