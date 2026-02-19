package pgx

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphquery "github.com/OFFIS-RIT/kiwi/backend/pkg/query"
	querypgx "github.com/OFFIS-RIT/kiwi/backend/pkg/query/pgx"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pgvector/pgvector-go"
)

func truncateDescription(desc string, maxLen int) string {
	desc = strings.ReplaceAll(desc, "\n", " ")
	desc = strings.ReplaceAll(desc, "\r", " ")
	if len(desc) <= maxLen {
		return desc
	}
	return desc[:maxLen] + "..."
}

func toolSearchEntities(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "search_entities",
		Description: "Search for entities in the knowledge graph by semantic similarity. Returns a list of entities matching the query. Use this as the entry point to explore the graph.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{
					"type":        "string",
					"description": "The search query to find relevant entities using semantic similarity.",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "Maximum number of entities to return (default: 10).",
					"default":     10,
				},
			},
			"required": []string{"query"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			query, ok := params["query"].(string)
			if !ok || query == "" {
				return "", fmt.Errorf("query is required and must be a string")
			}

			var limit int32 = 10
			if limitRaw, ok := params["limit"].(float64); ok && limitRaw > 0 {
				limit = int32(limitRaw)
			}

			logger.Debug("[Tool] search_entities", "query", query, "limit", limit)

			embedding, err := aiClient.GenerateEmbedding(ctx, []byte(query))
			if err != nil {
				return "", fmt.Errorf("failed to generate embedding: %w", err)
			}

			q := pgdb.New(conn)
			entities, err := q.SearchEntitiesByEmbedding(ctx, pgdb.SearchEntitiesByEmbeddingParams{
				ProjectID: projectId,
				Embedding: pgvector.NewVector(embedding),
				Limit:     limit,
			})
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to search entities: %w", err)
			}
			if len(entities) > 0 {
				ids := make([]int64, 0, len(entities))
				for _, e := range entities {
					ids = append(ids, e.ID)
				}
				graphquery.RecordQueriedEntityIDs(trace, ids...)
			}

			var result strings.Builder
			result.WriteString("## Entities\n")
			if len(entities) == 0 {
				result.WriteString("No entities found matching the query.\n")
			} else {
				for i, e := range entities {
					desc := truncateDescription(e.Description, 150)
					fmt.Fprintf(&result, "%d. [ID: %d] %s (%s): %s\n", i+1, e.ID, e.Name, e.Type, desc)
				}
			}

			return result.String(), nil
		},
	}
}

func toolGetEntityNeighbours(conn *pgxpool.Pool, aiClient ai.GraphAIClient, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "get_entity_neighbours",
		Description: "Get entities directly connected to a given entity through relationships. Results are ranked by semantic similarity to the query. Use this to explore the graph structure around an entity.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"entity_id": map[string]any{
					"type":        "integer",
					"description": "The ID of the entity whose neighbours to retrieve.",
				},
				"query": map[string]any{
					"type":        "string",
					"description": "The search query to rank neighbours by relevance.",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "Maximum number of neighbours to return (default: 10).",
					"default":     10,
				},
			},
			"required": []string{"entity_id", "query"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			entityIdRaw, ok := params["entity_id"].(float64)
			if !ok {
				return "", fmt.Errorf("entity_id is required and must be an integer")
			}
			entityId := int64(entityIdRaw)
			graphquery.RecordQueriedEntityIDs(trace, entityId)

			query, ok := params["query"].(string)
			if !ok || query == "" {
				return "", fmt.Errorf("query is required and must be a string")
			}

			var limit int32 = 10
			if limitRaw, ok := params["limit"].(float64); ok && limitRaw > 0 {
				limit = int32(limitRaw)
			}

			logger.Debug("[Tool] get_entity_neighbours", "entity_id", entityId, "query", query, "limit", limit)

			embedding, err := aiClient.GenerateEmbedding(ctx, []byte(query))
			if err != nil {
				return "", fmt.Errorf("failed to generate embedding: %w", err)
			}

			q := pgdb.New(conn)
			neighbours, err := q.GetEntityNeighboursRanked(ctx, pgdb.GetEntityNeighboursRankedParams{
				SourceID:  entityId,
				Embedding: pgvector.NewVector(embedding),
				Limit:     limit,
			})
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to get neighbours: %w", err)
			}
			if len(neighbours) > 0 {
				neighbourIDs := make([]int64, 0, len(neighbours))
				relIDs := make([]int64, 0, len(neighbours))
				for _, n := range neighbours {
					neighbourIDs = append(neighbourIDs, n.NeighbourID)
					relIDs = append(relIDs, n.RelationshipID)
				}
				graphquery.RecordQueriedEntityIDs(trace, neighbourIDs...)
				graphquery.RecordQueriedRelationshipIDs(trace, relIDs...)
			}

			var result strings.Builder
			fmt.Fprintf(&result, "## Neighbours of Entity ID: %d\n", entityId)
			if len(neighbours) == 0 {
				result.WriteString("No neighbours found for this entity.\n")
			} else {
				for i, n := range neighbours {
					desc := truncateDescription(n.NeighbourDescription, 150)
					relDesc := truncateDescription(n.RelationshipDescription, 100)
					fmt.Fprintf(&result, "%d. [Rel ID: %d] \"%s\" (ID: %d, %s) - \"%s\" (rank: %.2f)\n   %s\n",
						i+1, n.RelationshipID, n.NeighbourName, n.NeighbourID, n.NeighbourType, relDesc, n.Rank, desc)
				}
			}

			return result.String(), nil
		},
	}
}

func toolPathBetweenEntities(conn *pgxpool.Pool, projectId int64, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "path_between_entities",
		Description: "Find the shortest path between two entities in the knowledge graph. Returns the sequence of entities and relationships connecting them.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"start_id": map[string]any{
					"type":        "integer",
					"description": "The ID of the starting entity.",
				},
				"end_id": map[string]any{
					"type":        "integer",
					"description": "The ID of the target entity.",
				},
				"depth": map[string]any{
					"type":        "integer",
					"description": "Maximum path length to search (default: 10).",
					"default":     10,
				},
			},
			"required": []string{"start_id", "end_id"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			startIdRaw, ok := params["start_id"].(float64)
			if !ok {
				return "", fmt.Errorf("start_id is required and must be an integer")
			}
			startId := int64(startIdRaw)

			endIdRaw, ok := params["end_id"].(float64)
			if !ok {
				return "", fmt.Errorf("end_id is required and must be an integer")
			}
			endId := int64(endIdRaw)
			graphquery.RecordQueriedEntityIDs(trace, startId, endId)

			logger.Debug("[Tool] path_between_entities", "start_id", startId, "end_id", endId)

			// Dijkstra query to find shortest path
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
						WHERE project_id = %d',
						$1::bigint,
						$2::bigint,
						directed := false
					)
				)
				SELECT
					r.id,
					r.description,
					r.source_id,
					r.target_id
				FROM route rt
				JOIN relationships r ON r.id = rt.edge
				WHERE rt.edge != -1
				ORDER BY rt.path_seq;
			`, projectId)

			rows, err := conn.Query(ctx, query, startId, endId)
			if err != nil {
				return "", fmt.Errorf("failed to find path: %w", err)
			}
			defer rows.Close()

			type pathRelation struct {
				ID          int64
				Description string
				SourceId    int64
				TargetId    int64
			}

			var relations []pathRelation
			entityIds := make(map[int64]bool)
			entityIds[startId] = true
			entityIds[endId] = true

			for rows.Next() {
				var rel pathRelation
				if err := rows.Scan(&rel.ID, &rel.Description, &rel.SourceId, &rel.TargetId); err != nil {
					return "", fmt.Errorf("failed to scan path row: %w", err)
				}
				relations = append(relations, rel)
				entityIds[rel.SourceId] = true
				entityIds[rel.TargetId] = true
			}
			if len(relations) > 0 {
				relIDs := make([]int64, 0, len(relations))
				for _, r := range relations {
					relIDs = append(relIDs, r.ID)
				}
				graphquery.RecordQueriedRelationshipIDs(trace, relIDs...)
			}
			if len(entityIds) > 0 {
				entityIDs := make([]int64, 0, len(entityIds))
				for id := range entityIds {
					entityIDs = append(entityIDs, id)
				}
				graphquery.RecordQueriedEntityIDs(trace, entityIDs...)
			}

			if len(relations) == 0 {
				return fmt.Sprintf("## Path\nNo path found between entity %d and entity %d.\n", startId, endId), nil
			}

			// Fetch entity names
			ids := make([]int64, 0, len(entityIds))
			for id := range entityIds {
				ids = append(ids, id)
			}

			q := pgdb.New(conn)
			entities, err := q.GetProjectEntitiesByIDs(ctx, ids)
			if err != nil {
				return "", fmt.Errorf("failed to get entity names: %w", err)
			}

			entityNames := make(map[int64]string)
			for _, e := range entities {
				entityNames[e.ID] = e.Name
			}

			var result strings.Builder
			fmt.Fprintf(&result, "## Path from \"%s\" (ID: %d) to \"%s\" (ID: %d)\n",
				entityNames[startId], startId, entityNames[endId], endId)

			currentEntity := startId
			fmt.Fprintf(&result, "%d \"%s\"", currentEntity, entityNames[currentEntity])

			for _, rel := range relations {
				var nextEntity int64
				if rel.SourceId == currentEntity {
					nextEntity = rel.TargetId
				} else {
					nextEntity = rel.SourceId
				}
				relDesc := truncateDescription(rel.Description, 50)
				fmt.Fprintf(&result, " --[%s (rel %d)]--> %d \"%s\"", relDesc, rel.ID, nextEntity, entityNames[nextEntity])
				currentEntity = nextEntity
			}
			result.WriteString("\n")

			return result.String(), nil
		},
	}
}

func toolGetEntitySources(conn *pgxpool.Pool, aiClient ai.GraphAIClient, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "get_entity_sources",
		Description: "Retrieve source text chunks that describe specific entities, ranked by relevance to the query. Use this to get detailed information about entities.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"entity_ids": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "integer"},
					"description": "The IDs of the entities to retrieve sources for.",
				},
				"query": map[string]any{
					"type":        "string",
					"description": "The search query to rank sources by relevance.",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "Maximum number of sources to return (default: 10).",
					"default":     10,
				},
			},
			"required": []string{"entity_ids", "query"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			entityIdsRaw, ok := params["entity_ids"].([]any)
			if !ok || len(entityIdsRaw) == 0 {
				return "", fmt.Errorf("entity_ids is required and must be a non-empty array")
			}
			entityIds := make([]int64, 0, len(entityIdsRaw))
			for _, id := range entityIdsRaw {
				if idFloat, ok := id.(float64); ok {
					entityIds = append(entityIds, int64(idFloat))
				}
			}
			graphquery.RecordQueriedEntityIDs(trace, entityIds...)

			query, ok := params["query"].(string)
			if !ok || query == "" {
				return "", fmt.Errorf("query is required and must be a string")
			}

			var limit int32 = 10
			if limitRaw, ok := params["limit"].(float64); ok && limitRaw > 0 {
				limit = int32(limitRaw)
			}

			logger.Debug("[Tool] get_entity_sources", "entity_ids", entityIds, "query", query, "limit", limit)

			embedding, err := aiClient.GenerateEmbedding(ctx, []byte(query))
			if err != nil {
				return "", fmt.Errorf("failed to generate embedding: %w", err)
			}

			q := pgdb.New(conn)
			sources, err := q.FindRelevantSourcesForEntities(ctx, pgdb.FindRelevantSourcesForEntitiesParams{
				Column1:   entityIds,
				Embedding: pgvector.NewVector(embedding),
				Limit:     limit,
			})
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to get sources: %w", err)
			}
			if len(sources) > 0 {
				sourceIDs := make([]string, 0, len(sources))
				for _, s := range sources {
					sourceIDs = append(sourceIDs, s.PublicID)
				}
				graphquery.RecordConsideredSourceIDs(trace, sourceIDs...)
				graphquery.RecordUsedSourceIDs(trace, sourceIDs...)
			}

			var result strings.Builder
			result.WriteString("## Entity Sources\n")
			if len(sources) == 0 {
				result.WriteString("No sources found for the specified entities.\n")
			} else {
				for i, s := range sources {
					desc := strings.ReplaceAll(s.Description, "\n", " ")
					desc = strings.ReplaceAll(desc, "\r", " ")
					fmt.Fprintf(&result, "%d. [Entity ID: %d] (Source: %s): %s\n", i+1, s.EntityID, s.PublicID, desc)
				}
			}

			return result.String(), nil
		},
	}
}

func toolGetRelationshipSources(conn *pgxpool.Pool, aiClient ai.GraphAIClient, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "get_relationship_sources",
		Description: "Retrieve source text chunks that describe specific relationships, ranked by relevance to the query. Use this to get detailed information about how entities are connected.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"relationship_ids": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "integer"},
					"description": "The IDs of the relationships to retrieve sources for.",
				},
				"query": map[string]any{
					"type":        "string",
					"description": "The search query to rank sources by relevance.",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "Maximum number of sources to return (default: 10).",
					"default":     10,
				},
			},
			"required": []string{"relationship_ids", "query"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			relationshipIdsRaw, ok := params["relationship_ids"].([]any)
			if !ok || len(relationshipIdsRaw) == 0 {
				return "", fmt.Errorf("relationship_ids is required and must be a non-empty array")
			}
			relationshipIds := make([]int64, 0, len(relationshipIdsRaw))
			for _, id := range relationshipIdsRaw {
				if idFloat, ok := id.(float64); ok {
					relationshipIds = append(relationshipIds, int64(idFloat))
				}
			}
			graphquery.RecordQueriedRelationshipIDs(trace, relationshipIds...)

			query, ok := params["query"].(string)
			if !ok || query == "" {
				return "", fmt.Errorf("query is required and must be a string")
			}

			var limit int32 = 10
			if limitRaw, ok := params["limit"].(float64); ok && limitRaw > 0 {
				limit = int32(limitRaw)
			}

			logger.Debug("[Tool] get_relationship_sources", "relationship_ids", relationshipIds, "query", query, "limit", limit)

			embedding, err := aiClient.GenerateEmbedding(ctx, []byte(query))
			if err != nil {
				return "", fmt.Errorf("failed to generate embedding: %w", err)
			}

			q := pgdb.New(conn)
			sources, err := q.FindRelevantSourcesForRelations(ctx, pgdb.FindRelevantSourcesForRelationsParams{
				Column1:   relationshipIds,
				Embedding: pgvector.NewVector(embedding),
				Limit:     limit,
			})
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to get sources: %w", err)
			}
			if len(sources) > 0 {
				sourceIDs := make([]string, 0, len(sources))
				entityIDs := make([]int64, 0, len(sources)*2)
				for _, s := range sources {
					sourceIDs = append(sourceIDs, s.PublicID)
					entityIDs = append(entityIDs, s.SourceID, s.TargetID)
				}
				graphquery.RecordConsideredSourceIDs(trace, sourceIDs...)
				graphquery.RecordUsedSourceIDs(trace, sourceIDs...)
				graphquery.RecordQueriedEntityIDs(trace, entityIDs...)
			}

			var result strings.Builder
			result.WriteString("## Relationship Sources\n")
			if len(sources) == 0 {
				result.WriteString("No sources found for the specified relationships.\n")
			} else {
				for i, s := range sources {
					desc := strings.ReplaceAll(s.Description, "\n", " ")
					desc = strings.ReplaceAll(desc, "\r", " ")
					fmt.Fprintf(&result, "%d. [%d <-> %d] (Source: %s): %s\n", i+1, s.SourceID, s.TargetID, s.PublicID, desc)
				}
			}

			return result.String(), nil
		},
	}
}

func toolGetEntityDetails(conn *pgxpool.Pool, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "get_entity_details",
		Description: "Get full details of specific entities by their IDs. Returns complete entity information including full descriptions. Use this when you need more detail than the truncated descriptions from search results.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"entity_ids": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "integer"},
					"description": "The IDs of the entities to retrieve details for (max 100).",
				},
			},
			"required": []string{"entity_ids"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			entityIdsRaw, ok := params["entity_ids"].([]any)
			if !ok || len(entityIdsRaw) == 0 {
				return "", fmt.Errorf("entity_ids is required and must be a non-empty array")
			}
			if len(entityIdsRaw) > 100 {
				return "", fmt.Errorf("entity_ids is limited to 100 entities maximum")
			}

			entityIds := make([]int64, 0, len(entityIdsRaw))
			for _, id := range entityIdsRaw {
				if idFloat, ok := id.(float64); ok {
					entityIds = append(entityIds, int64(idFloat))
				}
			}
			graphquery.RecordQueriedEntityIDs(trace, entityIds...)

			logger.Debug("[Tool] get_entity_details", "entity_ids", entityIds)

			q := pgdb.New(conn)
			entities, err := q.GetProjectEntitiesByIDs(ctx, entityIds)
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to get entity details: %w", err)
			}

			var result strings.Builder
			result.WriteString("## Entity Details\n")
			if len(entities) == 0 {
				result.WriteString("No entities found with the specified IDs.\n")
			} else {
				for i, e := range entities {
					desc := strings.ReplaceAll(e.Description, "\n", " ")
					desc = strings.ReplaceAll(desc, "\r", " ")
					fmt.Fprintf(&result, "%d. [ID: %d] %s (%s)\n   %s\n\n", i+1, e.ID, e.Name, e.Type, desc)
				}
			}

			return result.String(), nil
		},
	}
}

func toolGetEntityTypes(conn *pgxpool.Pool, projectId int64) ai.Tool {
	return ai.Tool{
		Name:        "get_entity_types",
		Description: "List all entity types in the knowledge graph with their counts. Use this to understand what kinds of entities exist in the graph.",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
			"required":   []string{},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			logger.Debug("[Tool] get_entity_types")

			q := pgdb.New(conn)
			types, err := q.GetEntityTypes(ctx, projectId)
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to get entity types: %w", err)
			}

			var result strings.Builder
			result.WriteString("## Entity Types\n")
			if len(types) == 0 {
				result.WriteString("No entities found in the graph.\n")
			} else {
				for i, t := range types {
					fmt.Fprintf(&result, "%d. %s: %d entities\n", i+1, t.Type, t.Count)
				}
			}

			return result.String(), nil
		},
	}
}

func toolSearchEntitiesByType(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "search_entities_by_type",
		Description: "Search for entities of a specific type by semantic similarity. Use this when you want to find entities of a particular type (e.g., all Person entities related to a topic).",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{
					"type":        "string",
					"description": "The search query to find relevant entities using semantic similarity.",
				},
				"type": map[string]any{
					"type":        "string",
					"description": "The entity type to filter by (e.g., Person, Organization, Location).",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "Maximum number of entities to return (default: 10).",
					"default":     10,
				},
			},
			"required": []string{"query", "type"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			query, ok := params["query"].(string)
			if !ok || query == "" {
				return "", fmt.Errorf("query is required and must be a string")
			}

			entityType, ok := params["type"].(string)
			if !ok || entityType == "" {
				return "", fmt.Errorf("type is required and must be a string")
			}
			graphquery.RecordQueriedEntityTypes(trace, entityType)

			var limit int32 = 10
			if limitRaw, ok := params["limit"].(float64); ok && limitRaw > 0 {
				limit = int32(limitRaw)
			}

			logger.Debug("[Tool] search_entities_by_type", "query", query, "type", entityType, "limit", limit)

			embedding, err := aiClient.GenerateEmbedding(ctx, []byte(query))
			if err != nil {
				return "", fmt.Errorf("failed to generate embedding: %w", err)
			}

			q := pgdb.New(conn)
			entities, err := q.SearchEntitiesByType(ctx, pgdb.SearchEntitiesByTypeParams{
				ProjectID: projectId,
				Type:      entityType,
				Embedding: pgvector.NewVector(embedding),
				Limit:     limit,
			})
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to search entities: %w", err)
			}
			if len(entities) > 0 {
				ids := make([]int64, 0, len(entities))
				for _, e := range entities {
					ids = append(ids, e.ID)
				}
				graphquery.RecordQueriedEntityIDs(trace, ids...)
			}

			var result strings.Builder
			fmt.Fprintf(&result, "## Entities of type \"%s\"\n", entityType)
			if len(entities) == 0 {
				fmt.Fprintf(&result, "No entities of type \"%s\" found matching the query.\n", entityType)
			} else {
				for i, e := range entities {
					desc := truncateDescription(e.Description, 150)
					fmt.Fprintf(&result, "%d. [ID: %d] %s (%s): %s\n", i+1, e.ID, e.Name, e.Type, desc)
				}
			}

			return result.String(), nil
		},
	}
}

func toolSearchRelationships(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "search_relationships",
		Description: "Search for relationships in the knowledge graph by semantic similarity. Returns relationships describing how entities are connected, including their strength score. Use this to find specific connections or interactions between entities.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{
					"type":        "string",
					"description": "The search query to find relevant relationships using semantic similarity.",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "Maximum number of relationships to return (default: 10).",
					"default":     10,
				},
			},
			"required": []string{"query"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			query, ok := params["query"].(string)
			if !ok || query == "" {
				return "", fmt.Errorf("query is required and must be a string")
			}

			var limit int32 = 10
			if limitRaw, ok := params["limit"].(float64); ok && limitRaw > 0 {
				limit = int32(limitRaw)
			}

			logger.Debug("[Tool] search_relationships", "query", query, "limit", limit)

			embedding, err := aiClient.GenerateEmbedding(ctx, []byte(query))
			if err != nil {
				return "", fmt.Errorf("failed to generate embedding: %w", err)
			}

			q := pgdb.New(conn)
			relationships, err := q.SearchRelationshipsByEmbedding(ctx, pgdb.SearchRelationshipsByEmbeddingParams{
				ProjectID: projectId,
				Embedding: pgvector.NewVector(embedding),
				Limit:     limit,
			})
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to search relationships: %w", err)
			}
			if len(relationships) > 0 {
				relIDs := make([]int64, 0, len(relationships))
				entityIDs := make([]int64, 0, len(relationships)*2)
				for _, r := range relationships {
					relIDs = append(relIDs, r.ID)
					entityIDs = append(entityIDs, r.SourceID, r.TargetID)
				}
				graphquery.RecordQueriedRelationshipIDs(trace, relIDs...)
				graphquery.RecordQueriedEntityIDs(trace, entityIDs...)
			}

			var result strings.Builder
			result.WriteString("## Relationships\n")
			if len(relationships) == 0 {
				result.WriteString("No relationships found matching the query.\n")
			} else {
				for i, r := range relationships {
					desc := truncateDescription(r.Description, 150)
					fmt.Fprintf(&result, "%d. [ID: %d] %s (%s) <-> %s (%s) (strength: %.2f)\n   %s\n",
						i+1, r.ID, r.SourceName, r.SourceType, r.TargetName, r.TargetType, r.Rank, desc)
				}
			}

			return result.String(), nil
		},
	}
}

func toolGetRelationshipDetails(conn *pgxpool.Pool, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "get_relationship_details",
		Description: "Get full details of specific relationships by their IDs. Returns complete relationship information including full descriptions and strength scores. Use this when you need more detail than the truncated descriptions from search results.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"relationship_ids": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "integer"},
					"description": "The IDs of the relationships to retrieve details for (max 100).",
				},
			},
			"required": []string{"relationship_ids"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			relationshipIdsRaw, ok := params["relationship_ids"].([]any)
			if !ok || len(relationshipIdsRaw) == 0 {
				return "", fmt.Errorf("relationship_ids is required and must be a non-empty array")
			}
			if len(relationshipIdsRaw) > 100 {
				return "", fmt.Errorf("relationship_ids is limited to 100 relationships maximum")
			}

			relationshipIds := make([]int64, 0, len(relationshipIdsRaw))
			for _, id := range relationshipIdsRaw {
				if idFloat, ok := id.(float64); ok {
					relationshipIds = append(relationshipIds, int64(idFloat))
				}
			}
			graphquery.RecordQueriedRelationshipIDs(trace, relationshipIds...)

			logger.Debug("[Tool] get_relationship_details", "relationship_ids", relationshipIds)

			q := pgdb.New(conn)
			relationships, err := q.GetRelationshipsByIDs(ctx, relationshipIds)
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to get relationship details: %w", err)
			}
			if len(relationships) > 0 {
				entityIDs := make([]int64, 0, len(relationships)*2)
				for _, r := range relationships {
					entityIDs = append(entityIDs, r.SourceID, r.TargetID)
				}
				graphquery.RecordQueriedEntityIDs(trace, entityIDs...)
			}

			var result strings.Builder
			result.WriteString("## Relationship Details\n")
			if len(relationships) == 0 {
				result.WriteString("No relationships found with the specified IDs.\n")
			} else {
				for i, r := range relationships {
					desc := strings.ReplaceAll(r.Description, "\n", " ")
					desc = strings.ReplaceAll(desc, "\r", " ")
					fmt.Fprintf(&result, "%d. [ID: %d] %s (%s) <-> %s (%s) (strength: %.2f)\n   %s\n\n",
						i+1, r.ID, r.SourceName, r.SourceType, r.TargetName, r.TargetType, r.Rank, desc)
				}
			}

			return result.String(), nil
		},
	}
}

func toolGetSourceDocumentMetadata(conn *pgxpool.Pool, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "get_source_document_metadata",
		Description: "Get metadata (document type, date, summary) for the source documents associated with given source IDs. Use this to understand the context and nature of the source documents before citing them.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"source_ids": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "The public IDs of the sources (from get_entity_sources or get_relationship_sources) to get document metadata for.",
				},
			},
			"required": []string{"source_ids"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			var params map[string]any
			if err := json.Unmarshal([]byte(args), &params); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			sourceIdsRaw, ok := params["source_ids"].([]any)
			if !ok || len(sourceIdsRaw) == 0 {
				return "", fmt.Errorf("source_ids is required and must be a non-empty array")
			}
			sourceIds := make([]string, 0, len(sourceIdsRaw))
			for _, id := range sourceIdsRaw {
				if idStr, ok := id.(string); ok {
					sourceIds = append(sourceIds, idStr)
				}
			}
			graphquery.RecordConsideredSourceIDs(trace, sourceIds...)
			graphquery.RecordUsedSourceIDs(trace, sourceIds...)

			logger.Debug("[Tool] get_source_document_metadata", "source_ids", sourceIds)

			q := pgdb.New(conn)
			files, err := q.GetFilesWithMetadataFromTextUnitIDs(ctx, sourceIds)
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to get file metadata: %w", err)
			}

			var result strings.Builder
			result.WriteString("## Document Metadata\n")
			if len(files) == 0 {
				result.WriteString("No document metadata found for the specified sources.\n")
			} else {
				// Deduplicate by file_key
				seenFiles := make(map[string]bool)
				for _, f := range files {
					if seenFiles[f.FileKey] {
						continue
					}
					seenFiles[f.FileKey] = true

					metadata := "No metadata available"
					if f.Metadata.Valid && f.Metadata.String != "" {
						metadata = f.Metadata.String
					}
					fmt.Fprintf(&result, "**%s**:\n%s\n\n", f.Name, metadata)
				}
			}

			return result.String(), nil
		},
	}
}

func recordTraceSnapshot(trace graphquery.Tracer, snapshot graphquery.QueryTraceSnapshot) {
	graphquery.RecordConsideredSourceIDs(trace, snapshot.ConsideredSourceIDs...)
	graphquery.RecordUsedSourceIDs(trace, snapshot.UsedSourceIDs...)
	graphquery.RecordQueriedEntityIDs(trace, snapshot.QueriedEntityIDs...)
	graphquery.RecordQueriedRelationshipIDs(trace, snapshot.QueriedRelationshipIDs...)
	graphquery.RecordQueriedEntityTypes(trace, snapshot.QueriedEntityTypes...)
}

func buildExpertSourceBriefNone(queryFocus string, gaps string) string {
	queryFocus = strings.TrimSpace(queryFocus)
	if queryFocus == "" {
		queryFocus = "source retrieval"
	}

	gaps = strings.TrimSpace(gaps)
	if gaps == "" {
		gaps = "No relevant evidence was found."
	}

	return fmt.Sprintf("## Expert Source Brief\n- decision: none\n- query_focus: %s\n- sources: []\n- gaps: %s", queryFocus, gaps)
}

func toolAskExpert(conn *pgxpool.Pool, aiClient ai.GraphAIClient, currentProjectID int64, currentUserID int64, trace graphquery.Tracer) ai.Tool {
	return ai.Tool{
		Name:        "ask_expert",
		Description: "Ask up to 3 expert graphs in one call. Provide a requests array with expert_graph_id and question. The tool runs internal agentic retrieval loops in parallel and returns structured source briefs (IDs + relevance), not user-facing answers.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"requests": map[string]any{
					"type":        "array",
					"description": "Batch of expert requests (1-3). Each entry contains expert_graph_id and question.",
					"minItems":    1,
					"maxItems":    3,
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"expert_graph_id": map[string]any{
								"type":        "integer",
								"description": "Graph ID to query.",
							},
							"question": map[string]any{
								"type":        "string",
								"description": "Focused sub-question for this graph.",
							},
						},
						"required": []string{"expert_graph_id", "question"},
					},
				},
			},
			"required": []string{"requests"},
		},
		Handler: func(ctx context.Context, args string) (string, error) {
			type expertRequest struct {
				ExpertGraphID int64  `json:"expert_graph_id"`
				Question      string `json:"question"`
			}

			type askExpertPayload struct {
				Requests []expertRequest `json:"requests"`
			}

			type expertResult struct {
				GraphID     int64
				GraphName   string
				SourceBrief string
				Err         error
			}

			var payload askExpertPayload
			if err := json.Unmarshal([]byte(args), &payload); err != nil {
				return "", fmt.Errorf("failed to parse arguments: %w", err)
			}

			if len(payload.Requests) == 0 {
				return "", fmt.Errorf("requests is required and must contain at least one entry")
			}
			if len(payload.Requests) > 3 {
				return "", fmt.Errorf("requests supports a maximum of 3 entries")
			}

			for i := range payload.Requests {
				payload.Requests[i].Question = strings.TrimSpace(payload.Requests[i].Question)
				if payload.Requests[i].ExpertGraphID <= 0 {
					return "", fmt.Errorf("requests[%d].expert_graph_id must be a positive integer", i)
				}
				if payload.Requests[i].Question == "" {
					return "", fmt.Errorf("requests[%d].question is required and must be a non-empty string", i)
				}
			}

			logger.Debug("[Tool] ask_expert", "request_count", len(payload.Requests), "current_project_id", currentProjectID)

			results := make([]expertResult, len(payload.Requests))
			var wg sync.WaitGroup

			for i, request := range payload.Requests {
				wg.Add(1)
				go func(index int, req expertRequest) {
					defer wg.Done()

					res := expertResult{GraphID: req.ExpertGraphID}
					q := pgdb.New(conn)

					graph, err := q.GetProjectByID(ctx, req.ExpertGraphID)
					if err != nil {
						if err == sql.ErrNoRows {
							res.SourceBrief = buildExpertSourceBriefNone("graph lookup", fmt.Sprintf("Graph with ID %d does not exist.", req.ExpertGraphID))
							results[index] = res
							return
						}

						res.Err = fmt.Errorf("failed to load graph %d: %w", req.ExpertGraphID, err)
						results[index] = res
						return
					}

					res.GraphName = graph.Name
					if graph.State != "ready" {
						res.SourceBrief = buildExpertSourceBriefNone("graph readiness", fmt.Sprintf("Graph with ID %d is not ready yet (current state: %s).", req.ExpertGraphID, graph.State))
						results[index] = res
						return
					}

					innerTrace := graphquery.NewQueryTrace()
					defer func() {
						recordTraceSnapshot(trace, innerTrace.Snapshot())
					}()

					innerStorage, err := NewGraphDBStorageWithConnection(ctx, conn, aiClient, []string{req.Question}, WithTracer(innerTrace))
					if err != nil {
						res.Err = fmt.Errorf("failed to create expert graph storage for graph %d: %w", req.ExpertGraphID, err)
						results[index] = res
						return
					}

					projectPrompts, err := q.GetProjectSystemPrompts(ctx, req.ExpertGraphID)
					if err != nil && err != sql.ErrNoRows {
						res.Err = fmt.Errorf("failed to load system prompts for graph %d: %w", req.ExpertGraphID, err)
						results[index] = res
						return
					}

					innerOpts := []querypgx.QueryOption{
						querypgx.WithAgenticPrompt(ai.ExpertToolQueryPrompt),
					}
					if len(projectPrompts) > 0 {
						systemPrompts := make([]string, 0, len(projectPrompts))
						for _, p := range projectPrompts {
							systemPrompts = append(systemPrompts, p.Prompt)
						}
						innerOpts = append(innerOpts, querypgx.WithSystemPrompts(systemPrompts...))
					}

					innerQueryClient := querypgx.NewGraphQueryClient(aiClient, innerStorage, fmt.Sprintf("%d", req.ExpertGraphID), innerOpts)
					innerTools := getToolList(conn, aiClient, req.ExpertGraphID, currentUserID, innerTrace, false)
					innerAnswer, err := innerQueryClient.QueryAgentic(ctx, []ai.ChatMessage{{Role: "user", Message: req.Question}}, innerTools)
					if err != nil {
						res.Err = fmt.Errorf("failed to query graph %d: %w", req.ExpertGraphID, err)
						results[index] = res
						return
					}

					innerAnswer = strings.TrimSpace(innerAnswer)
					if innerAnswer == "" {
						innerAnswer = buildExpertSourceBriefNone("source retrieval", "The expert retrieval returned no structured source output.")
					}

					res.SourceBrief = innerAnswer
					results[index] = res
				}(i, request)
			}

			wg.Wait()

			var result strings.Builder
			result.WriteString("## Expert Source Relay\n")
			fmt.Fprintf(&result, "- requested_experts: %d\n", len(payload.Requests))

			for i, res := range results {
				result.WriteString("\n")
				fmt.Fprintf(&result, "### Expert Request %d\n", i+1)
				fmt.Fprintf(&result, "- expert_graph_id: %d\n", res.GraphID)
				if strings.TrimSpace(res.GraphName) != "" {
					fmt.Fprintf(&result, "- expert_graph_name: %s\n", res.GraphName)
				}

				if res.Err != nil {
					result.WriteString("- status: error\n")
					errMessage := strings.ReplaceAll(strings.TrimSpace(res.Err.Error()), "\n", " ")
					fmt.Fprintf(&result, "- error: %s\n\n", errMessage)
					result.WriteString(buildExpertSourceBriefNone("expert execution", "Internal expert retrieval failed for this request."))
					result.WriteString("\n")
					continue
				}

				result.WriteString("- status: ok\n\n")
				sourceBrief := strings.TrimSpace(res.SourceBrief)
				if sourceBrief == "" {
					sourceBrief = buildExpertSourceBriefNone("source retrieval", "The expert retrieval returned no structured source output.")
				}
				result.WriteString(sourceBrief)
				result.WriteString("\n")
			}

			return strings.TrimSpace(result.String()), nil
		},
	}
}

// GetClarificationTool returns a client-executed tool that requests
// clarification questions from the user when the prompt is ambiguous.
func GetClarificationTool() ai.Tool {
	return ai.Tool{
		Name:        "ask_clarifying_questions",
		Description: "Use this only when the user request is ambiguous or underspecified and you would otherwise need to guess. Ask 1-3 concise clarification questions in the user's language before calling retrieval tools. The tool result will contain the user's clarification answer as plain text.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"questions": map[string]any{
					"type":        "array",
					"description": "List of 1-3 concise, actionable clarification questions.",
					"items": map[string]any{
						"type": "string",
					},
					"minItems": 1,
					"maxItems": 3,
				},
				"reason": map[string]any{
					"type":        "string",
					"description": "Short explanation of what information is missing.",
				},
			},
			"required": []string{"questions"},
		},
		Execution: ai.ToolExecutionClient,
	}
}

// GetToolList returns a set of AI tools for exploring and querying a knowledge
// graph. Tools include entity search, relationship search, neighbour exploration,
// path finding, source retrieval, and document metadata access. These tools
// enable agentic workflows where the AI can navigate the graph structure
// autonomously.
func getToolList(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64, currentUserID int64, trace graphquery.Tracer, includeAskExpert bool) []ai.Tool {
	tools := []ai.Tool{
		toolSearchEntities(conn, aiClient, projectId, trace),
		toolSearchRelationships(conn, aiClient, projectId, trace),
		toolGetEntityNeighbours(conn, aiClient, trace),
		toolPathBetweenEntities(conn, projectId, trace),
		toolGetEntitySources(conn, aiClient, trace),
		toolGetRelationshipSources(conn, aiClient, trace),
		toolGetEntityDetails(conn, trace),
		toolGetRelationshipDetails(conn, trace),
		toolGetEntityTypes(conn, projectId),
		toolSearchEntitiesByType(conn, aiClient, projectId, trace),
		toolGetSourceDocumentMetadata(conn, trace),
	}

	if includeAskExpert {
		tools = append(tools, toolAskExpert(conn, aiClient, projectId, currentUserID, trace))
	}

	return tools
}

func GetToolList(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64, currentUserID int64, trace graphquery.Tracer) []ai.Tool {
	return getToolList(conn, aiClient, projectId, currentUserID, trace, true)
}
