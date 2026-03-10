package pgdb

import (
	"strings"
	"testing"
)

func TestDedupeEntityQueriesAreProjectScoped(t *testing.T) {
	tests := []struct {
		name     string
		query    string
		contains []string
	}{
		{
			name:  "find similar entities",
			query: findEntitiesWithSimilarNames,
			contains: []string{
				"e2.project_id =",
				"e1.project_id =",
			},
		},
		{
			name:  "find similar entities for seed ids",
			query: findEntitiesWithSimilarNamesForEntityIDs,
			contains: []string{
				"WHERE e.project_id =",
				"candidate.project_id =",
			},
		},
		{
			name:  "lock entities for merge",
			query: getProjectEntitiesByIDsForUpdate,
			contains: []string{
				"WHERE e.project_id =",
				"FOR UPDATE",
			},
		},
		{
			name:  "load entities with source counts",
			query: getProjectEntitiesWithSourceCountsByIDs,
			contains: []string{
				"WHERE e.project_id =",
				"AND e.id = ANY(",
			},
		},
		{
			name:  "rename canonical entity",
			query: updateEntityName,
			contains: []string{
				"WHERE id =",
				"AND project_id =",
			},
		},
		{
			name:  "transfer entity sources",
			query: transferEntitySourcesBatch,
			contains: []string{
				"FROM entities e",
				"e.project_id =",
				"es.entity_id = ANY(",
			},
		},
		{
			name:  "delete duplicate entities",
			query: deleteProjectEntitiesByIDs,
			contains: []string{
				"WHERE project_id =",
				"AND id = ANY(",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for _, needle := range tc.contains {
				if !strings.Contains(tc.query, needle) {
					t.Fatalf("query %q missing %q\n%s", tc.name, needle, tc.query)
				}
			}
		})
	}
}

func TestDedupeRelationshipQueriesAreProjectScoped(t *testing.T) {
	tests := []struct {
		name     string
		query    string
		contains []string
	}{
		{
			name:  "update relationship sources",
			query: updateRelationshipSourceEntitiesBatch,
			contains: []string{
				"WHERE project_id =",
				"AND source_id = ANY(",
			},
		},
		{
			name:  "update relationship targets",
			query: updateRelationshipTargetEntitiesBatch,
			contains: []string{
				"WHERE project_id =",
				"AND target_id = ANY(",
			},
		},
		{
			name:  "delete duplicate relationships batch",
			query: deleteProjectRelationshipsByIDs,
			contains: []string{
				"WHERE project_id =",
				"AND id = ANY(",
			},
		},
		{
			name:  "transfer relationship sources batch",
			query: transferRelationshipSourcesBatchByMappings,
			contains: []string{
				"FROM input",
				"JOIN relationships r",
				"r.project_id =",
			},
		},
		{
			name:  "update relationship ranks batch",
			query: updateProjectRelationshipRanksByIDs,
			contains: []string{
				"WHERE r.id = input.id",
				"AND r.project_id =",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for _, needle := range tc.contains {
				if !strings.Contains(tc.query, needle) {
					t.Fatalf("query %q missing %q\n%s", tc.name, needle, tc.query)
				}
			}
		})
	}
}
