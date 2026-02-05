package pgx

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	graphquery "github.com/OFFIS-RIT/kiwi/backend/pkg/query"

	_ "github.com/invopop/jsonschema"
	"github.com/pgvector/pgvector-go"
)

// GetLocalQueryContext retrieves context for local queries using entity-focused
// search. It identifies relevant entities by name matching and embedding similarity,
// finds paths between entities, and aggregates sources from entities, relationships,
// and connecting nodes. Returns formatted context text or empty string if none found.
func (s *GraphDBStorage) GetLocalQueryContext(
	ctx context.Context,
	query string,
	embedding []float32,
	graphId string,
) (string, error) {
	projectId, err := strconv.ParseInt(graphId, 10, 64)
	if err != nil {
		return "", err
	}

	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return "", nil
	}
	defer tx.Rollback(ctx)

	q := pgdb.New(s.conn)
	qtx := q.WithTx(tx)

	entityNames, err := qtx.GetProjectEntityNames(ctx, projectId)
	if err != nil {
		return "", err
	}

	intent, err := s.getQueryIntent(ctx, query, entityNames, s.msgs)
	if err != nil {
		return "", err
	}

	relevantEntityIds := make([]int64, 0)
	relevantEntities, err := qtx.GetProjectEntitiesByNames(ctx, pgdb.GetProjectEntitiesByNamesParams{
		ProjectID: projectId,
		Column2:   intent.Entities,
	})
	for _, rel := range relevantEntities {
		relevantEntityIds = append(relevantEntityIds, rel.ID)
	}
	graphquery.RecordQueriedEntityIDs(s.trace, relevantEntityIds...)

	additionalEntityIds := make([]int64, 0)
	dbAdditionalEntityIds, err := s.getSimilarEntityIdsByEmebedding(ctx, qtx, projectId, embedding, 4)
	if err != nil {
		return "", err
	}
	for _, id := range dbAdditionalEntityIds {
		if slices.Contains(relevantEntityIds, id) {
			continue
		}
		additionalEntityIds = append(additionalEntityIds, id)
	}
	graphquery.RecordQueriedEntityIDs(s.trace, additionalEntityIds...)

	checkedPairs := make([]string, 0)

	foundPaths := make(map[int64]bool)
	pathEntityIds := make(map[int64]bool)
	for _, sourceId := range relevantEntityIds {
		for _, targetId := range relevantEntityIds {
			if sourceId == targetId {
				continue
			}

			var pairKey string
			if sourceId > targetId {
				pairKey = fmt.Sprintf("%d-%d", targetId, sourceId)
			} else {
				pairKey = fmt.Sprintf("%d-%d", sourceId, targetId)
			}

			if slices.Contains(checkedPairs, pairKey) {
				continue
			}

			rIds, pathEntities, relations, err := s.getPathBetweenEntities(
				ctx,
				tx,
				sourceId,
				targetId,
				graphId,
			)
			if err != nil {
				return "", err
			}

			for idx := range relations {
				rID := rIds[idx]
				if _, ok := foundPaths[rID]; !ok {
					foundPaths[rID] = true
				}
			}
			for _, e := range pathEntities {
				if _, ok := pathEntityIds[e]; !ok && !slices.Contains(relevantEntityIds, e) {
					pathEntityIds[e] = true
				}
			}
			checkedPairs = append(checkedPairs, pairKey)
		}
	}

	semanticEmbed, err := s.aiClient.GenerateEmbedding(ctx, []byte(intent.SemanticTerm))
	if err != nil {
		return "", err
	}
	embed := pgvector.NewVector(semanticEmbed)

	entitySourcesList := make(map[int64]bool)
	entitySources, err := qtx.FindRelevantEntitySources(ctx, pgdb.FindRelevantEntitySourcesParams{
		Column1:   relevantEntityIds,
		Embedding: embed,
		Limit:     30,
		Column4:   0.6,
	})
	if err != nil {
		return "", err
	}

	additionalEntitySources, err := qtx.FindRelevantEntitySources(ctx, pgdb.FindRelevantEntitySourcesParams{
		Column1:   additionalEntityIds,
		Embedding: embed,
		Limit:     10,
		Column4:   0.6,
	})
	if err != nil {
		return "", err
	}
	entitySources = append(entitySources, additionalEntitySources...)
	for _, source := range entitySources {
		entitySourcesList[source.ID] = true
	}

	additionalSources := make([]pgdb.FindSimilarEntitySourcesRow, 0)
	dbAdditionalSources, err := qtx.FindSimilarEntitySources(ctx, pgdb.FindSimilarEntitySourcesParams{
		Embedding: embed,
		ProjectID: projectId,
		Limit:     10,
		Column4:   0.4,
	})
	for _, source := range dbAdditionalSources {
		if _, ok := entitySourcesList[source.ID]; !ok {
			additionalSources = append(additionalSources, source)
		}
	}

	relationshipIds := make([]int64, 0, len(foundPaths))
	for id := range foundPaths {
		relationshipIds = append(relationshipIds, id)
	}
	graphquery.RecordQueriedRelationshipIDs(s.trace, relationshipIds...)

	relationshipSources, err := qtx.FindRelevantRelationSources(ctx, pgdb.FindRelevantRelationSourcesParams{
		Column1:   relationshipIds,
		Embedding: embed,
		Limit:     20,
		Column4:   0.6,
	})
	if err != nil {
		return "", err
	}

	pathEntityIdsList := make([]int64, 0, len(pathEntityIds))
	for id := range pathEntityIds {
		if slices.Contains(relevantEntityIds, id) {
			continue
		}
		if slices.Contains(additionalEntityIds, id) {
			continue
		}
		pathEntityIdsList = append(pathEntityIdsList, id)
	}
	graphquery.RecordQueriedEntityIDs(s.trace, pathEntityIdsList...)

	pathSources, err := qtx.FindRelevantEntitySources(ctx, pgdb.FindRelevantEntitySourcesParams{
		Column1:   pathEntityIdsList,
		Embedding: embed,
		Limit:     10,
		Column4:   0.6,
	})
	if err != nil {
		return "", err
	}

	var result strings.Builder
	var sections []string
	usedSourcePublicIds := make([]string, 0)

	err = tx.Commit(ctx)
	if err != nil {
		return "", nil
	}

	if len(entitySources) > 0 {
		var entitySection strings.Builder
		entitySection.WriteString("Relevant Entities:\n")
		for _, source := range entitySources {
			if source.Description != "" {
				usedSourcePublicIds = append(usedSourcePublicIds, source.PublicID_2)
				fmt.Fprintf(&entitySection, "%s,%s: %s\n", source.Name, source.PublicID_2, source.Description)
			}
		}
		sections = append(sections, entitySection.String())
	}

	if len(relationshipSources) > 0 {
		var relationshipSection strings.Builder
		relationshipSection.WriteString("Connecting Relationships:\n")
		for _, source := range relationshipSources {
			if source.Description != "" {
				usedSourcePublicIds = append(usedSourcePublicIds, source.PublicID_2)
				fmt.Fprintf(&relationshipSection, "%s<->%s,%s: %s\n", source.Name, source.Name_2, source.PublicID_2, source.Description)
			}
		}
		sections = append(sections, relationshipSection.String())
	}

	if len(pathSources) > 0 {
		var pathSection strings.Builder
		pathSection.WriteString("Connecting Entities:\n")
		for _, source := range pathSources {
			if source.Description != "" {
				usedSourcePublicIds = append(usedSourcePublicIds, source.PublicID_2)
				fmt.Fprintf(&pathSection, "%s,%s: %s\n", source.Name, source.PublicID_2, source.Description)
			}
		}
		sections = append(sections, pathSection.String())
	}

	if len(additionalSources) > 0 {
		var additionalSection strings.Builder
		additionalSection.WriteString("Additional Sources:\n")
		for _, source := range additionalSources {
			if source.Description != "" {
				usedSourcePublicIds = append(usedSourcePublicIds, source.PublicID_2)
				fmt.Fprintf(&additionalSection, "%s,%s: %s\n", source.Name, source.PublicID_2, source.Description)
			}
		}
		sections = append(sections, additionalSection.String())
	}

	// Collect all source public IDs for metadata lookup
	allSourcePublicIds := make([]string, 0)
	for _, source := range entitySources {
		allSourcePublicIds = append(allSourcePublicIds, source.PublicID_2)
	}
	for _, source := range additionalSources {
		allSourcePublicIds = append(allSourcePublicIds, source.PublicID_2)
	}
	for _, source := range relationshipSources {
		allSourcePublicIds = append(allSourcePublicIds, source.PublicID_2)
	}
	for _, source := range pathSources {
		allSourcePublicIds = append(allSourcePublicIds, source.PublicID_2)
	}

	// Get file metadata for document context
	if len(allSourcePublicIds) > 0 {
		filesWithMetadata, err := q.GetFilesWithMetadataFromTextUnitIDs(ctx, allSourcePublicIds)
		if err == nil && len(filesWithMetadata) > 0 {
			seenFiles := make(map[string]bool)
			var metadataSection strings.Builder
			hasMetadata := false
			metadataSection.WriteString("Document Metadata:\n")
			for _, f := range filesWithMetadata {
				if seenFiles[f.FileKey] {
					continue
				}
				seenFiles[f.FileKey] = true
				if f.Metadata.Valid && f.Metadata.String != "" {
					hasMetadata = true
					usedSourcePublicIds = append(usedSourcePublicIds, f.PublicID)
					fmt.Fprintf(&metadataSection, "%s: %s\n", f.Name, f.Metadata.String)
				}
			}
			if hasMetadata {
				sections = append(sections, metadataSection.String())
			}
		}
	}
	graphquery.RecordConsideredSourceIDs(s.trace, allSourcePublicIds...)
	graphquery.RecordUsedSourceIDs(s.trace, usedSourcePublicIds...)

	if len(sections) > 0 {
		result.WriteString(strings.Join(sections, "\n"))
		return strings.TrimSuffix(result.String(), "\n"), nil
	}

	return "", nil
}

type queryIntent struct {
	Entities     []string `json:"relevant_entities" jsonschema_description:"Subset of candidate entity names from the list that are directly relevant to the user question"`
	SemanticTerm string   `json:"semantic_term" jsonschema_description:"A single short natural sentence/phrase that fully captures the user’s intent, written to maximize matching in text embeddings"`
}

func (s *GraphDBStorage) getQueryIntent(
	ctx context.Context,
	query string,
	entities []string,
	msgs []string,
) (*queryIntent, error) {
	previousAnswer := ""
	if len(msgs) > 0 {
		previousAnswer = msgs[len(msgs)-1]
	}
	prompt := fmt.Sprintf(ai.SemanticPrompt, previousAnswer, query, strings.Join(entities, ", "))

	var intent queryIntent
	err := s.aiClient.GenerateCompletionWithFormat(ctx, "query_intent", "Generate an intent for the user query.", prompt, &intent)
	if err != nil {
		return nil, err
	}

	return &intent, nil
}
