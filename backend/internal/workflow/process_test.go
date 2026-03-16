package workflow

import (
	"fmt"
	"testing"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

func TestResolveDescriptionBatchSize_UsesStoredBatchSize(t *testing.T) {
	stats := []pgdb.WorkflowStat{{
		Metrics: marshalJSONValue(descriptionMetrics{BatchSize: 64, EntityCount: 30, RelationshipCount: 34}),
	}}

	if got := resolveDescriptionBatchSize(stats); got != 64 {
		t.Fatalf("expected 64, got %d", got)
	}
}

func TestResolveDescriptionBatchSize_UsesLegacySingleItemMetrics(t *testing.T) {
	stats := []pgdb.WorkflowStat{{
		Metrics: marshalJSONValue(descriptionMetrics{EntityCount: 1}),
	}}

	if got := resolveDescriptionBatchSize(stats); got != 1 {
		t.Fatalf("expected 1, got %d", got)
	}
}

func TestBuildDescriptionJobBatches_FillsEntitiesThenRelationships(t *testing.T) {
	entityIDs := make([]string, 30)
	entitySourceCounts := make(map[string]int32, len(entityIDs))
	for i := range entityIDs {
		entityIDs[i] = fmt.Sprintf("e-%d", i+1)
		entitySourceCounts[entityIDs[i]] = 1
	}

	relationshipIDs := make([]string, 100)
	relationshipSourceCounts := make(map[string]int32, len(relationshipIDs))
	for i := range relationshipIDs {
		relationshipIDs[i] = fmt.Sprintf("r-%d", 1000+i)
		relationshipSourceCounts[relationshipIDs[i]] = 1
	}

	batches := buildDescriptionJobBatches(64, entityIDs, entitySourceCounts, relationshipIDs, relationshipSourceCounts)
	if len(batches) != 3 {
		t.Fatalf("expected 3 batches, got %d", len(batches))
	}

	if got := len(batches[0].EntityIDs); got != 30 {
		t.Fatalf("expected first batch to include 30 entities, got %d", got)
	}
	if got := len(batches[0].RelationshipIDs); got != 34 {
		t.Fatalf("expected first batch to include 34 relationships, got %d", got)
	}
	if batches[0].Metrics.EntityCount != 30 || batches[0].Metrics.RelationshipCount != 34 {
		t.Fatalf("unexpected first batch metrics: %+v", batches[0].Metrics)
	}
	if batches[0].Metrics.SourceCount != 64 || batches[0].Metrics.BatchSize != 64 {
		t.Fatalf("unexpected first batch source metrics: %+v", batches[0].Metrics)
	}

	if got := len(batches[1].EntityIDs); got != 0 {
		t.Fatalf("expected second batch to include 0 entities, got %d", got)
	}
	if got := len(batches[1].RelationshipIDs); got != 64 {
		t.Fatalf("expected second batch to include 64 relationships, got %d", got)
	}
	if batches[1].Metrics.SourceCount != 64 {
		t.Fatalf("unexpected second batch metrics: %+v", batches[1].Metrics)
	}

	if got := len(batches[2].RelationshipIDs); got != 2 {
		t.Fatalf("expected final batch to include 2 relationships, got %d", got)
	}
	if batches[2].Metrics.SourceCount != 2 {
		t.Fatalf("unexpected final batch metrics: %+v", batches[2].Metrics)
	}
	if batches[2].RelationshipIDs[0] != relationshipIDs[98] || batches[2].RelationshipIDs[1] != relationshipIDs[99] {
		t.Fatalf("final batch relationships are not deterministic: %+v", batches[2].RelationshipIDs)
	}
}

func TestBuildDescriptionJobBatches_UsesSingleItemMinimum(t *testing.T) {
	batches := buildDescriptionJobBatches(0, []string{"1"}, map[string]int32{"1": 3}, []string{"2"}, map[string]int32{"2": 4})
	if len(batches) != 2 {
		t.Fatalf("expected 2 batches, got %d", len(batches))
	}
	if batches[0].Metrics.BatchSize != 1 || batches[1].Metrics.BatchSize != 1 {
		t.Fatalf("expected minimum batch size of 1, got %+v and %+v", batches[0].Metrics, batches[1].Metrics)
	}
}
