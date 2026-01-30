package pgx

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

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

func toolSearchEntities(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64) ai.Tool {
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
			if !ok {
				return "", fmt.Errorf("query is required and must be a string")
			}
			// If query is empty, use a generic fallback query
			if query == "" {
				query = "relationship connection"
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

func toolGetEntityNeighbours(conn *pgxpool.Pool, aiClient ai.GraphAIClient) ai.Tool {
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

			query, ok := params["query"].(string)
			if !ok {
				return "", fmt.Errorf("query is required and must be a string")
			}
			// If query is empty, fetch entity name and use it as fallback query
			if query == "" {
				q := pgdb.New(conn)
				entity, err := q.GetProjectEntityByID(ctx, entityId)
				if err != nil && err != sql.ErrNoRows {
					return "", fmt.Errorf("failed to get entity name for fallback query: %w", err)
				}
				if err == sql.ErrNoRows {
					return "", fmt.Errorf("query is required and must be a non-empty string")
				}
				query = entity.Name
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

func toolPathBetweenEntities(conn *pgxpool.Pool, projectId int64) ai.Tool {
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

func toolGetEntitySources(conn *pgxpool.Pool, aiClient ai.GraphAIClient) ai.Tool {
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

			query, ok := params["query"].(string)
			if !ok {
				return "", fmt.Errorf("query is required and must be a string")
			}
			// If query is empty, fetch entity names and use them as fallback query
			if query == "" {
				q := pgdb.New(conn)
				entities, err := q.GetProjectEntitiesByIDs(ctx, entityIds)
				if err != nil && err != sql.ErrNoRows {
					return "", fmt.Errorf("failed to get entity names for fallback query: %w", err)
				}
				if len(entities) == 0 {
					return "", fmt.Errorf("query is required and must be a non-empty string")
				}
				// Use entity names as query
				names := make([]string, len(entities))
				for i, e := range entities {
					names[i] = e.Name
				}
				query = strings.Join(names, " ")
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

func toolGetRelationshipSources(conn *pgxpool.Pool, aiClient ai.GraphAIClient) ai.Tool {
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

			query, ok := params["query"].(string)
			if !ok {
				return "", fmt.Errorf("query is required and must be a string")
			}
			// If query is empty, use a generic fallback query
			if query == "" {
				query = "relationship connection"
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

func toolGetEntityDetails(conn *pgxpool.Pool) ai.Tool {
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

func toolSearchEntitiesByType(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64) ai.Tool {
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
			if !ok {
				return "", fmt.Errorf("query is required and must be a string")
			}
			// If query is empty, use a generic fallback query
			if query == "" {
				query = "relationship connection"
			}

			entityType, ok := params["type"].(string)
			if !ok || entityType == "" {
				return "", fmt.Errorf("type is required and must be a string")
			}

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

func toolSearchRelationships(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64) ai.Tool {
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
			if !ok {
				return "", fmt.Errorf("query is required and must be a string")
			}
			// If query is empty, use a generic fallback query
			if query == "" {
				query = "relationship connection"
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

func toolGetRelationshipDetails(conn *pgxpool.Pool) ai.Tool {
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

			logger.Debug("[Tool] get_relationship_details", "relationship_ids", relationshipIds)

			q := pgdb.New(conn)
			relationships, err := q.GetRelationshipsByIDs(ctx, relationshipIds)
			if err != nil && err != sql.ErrNoRows {
				return "", fmt.Errorf("failed to get relationship details: %w", err)
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

func toolGetSourceDocumentMetadata(conn *pgxpool.Pool) ai.Tool {
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

// GetToolList returns a set of AI tools for exploring and querying a knowledge
// graph. Tools include entity search, relationship search, neighbour exploration,
// path finding, source retrieval, and document metadata access. These tools
// enable agentic workflows where the AI can navigate the graph structure
// autonomously.
func GetToolList(conn *pgxpool.Pool, aiClient ai.GraphAIClient, projectId int64) []ai.Tool {
	return []ai.Tool{
		toolSearchEntities(conn, aiClient, projectId),
		toolSearchRelationships(conn, aiClient, projectId),
		toolGetEntityNeighbours(conn, aiClient),
		toolPathBetweenEntities(conn, projectId),
		toolGetEntitySources(conn, aiClient),
		toolGetRelationshipSources(conn, aiClient),
		toolGetEntityDetails(conn),
		toolGetRelationshipDetails(conn),
		toolGetEntityTypes(conn, projectId),
		toolSearchEntitiesByType(conn, aiClient, projectId),
		toolGetSourceDocumentMetadata(conn),
	}
}
