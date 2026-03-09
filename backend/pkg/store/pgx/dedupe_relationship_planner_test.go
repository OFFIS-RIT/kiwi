package pgx

import (
	"math"
	"reflect"
	"testing"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

func TestRelationshipDedupePlanner_SingleIterationAveragesAllDuplicateRanks(t *testing.T) {
	planner := newRelationshipDedupePlanner([]pgdb.GetProjectRelationshipsRow{
		{ID: 1, SourceID: 10, TargetID: 20, Rank: 0.2},
		{ID: 2, SourceID: 10, TargetID: 20, Rank: 0.4},
		{ID: 3, SourceID: 20, TargetID: 10, Rank: 0.8},
		{ID: 4, SourceID: 30, TargetID: 40, Rank: 0.1},
	})

	planner.dedupeIteration()
	plan := planner.buildPlan()

	if !reflect.DeepEqual(plan.RelationshipIDs, []int64{2, 3}) {
		t.Fatalf("expected duplicate relationship ids [2 3], got %v", plan.RelationshipIDs)
	}
	if !reflect.DeepEqual(plan.CanonicalIDs, []int64{1, 1}) {
		t.Fatalf("expected canonical ids [1 1], got %v", plan.CanonicalIDs)
	}
	if !reflect.DeepEqual(plan.DeleteIDs, []int64{2, 3}) {
		t.Fatalf("expected delete ids [2 3], got %v", plan.DeleteIDs)
	}
	if !reflect.DeepEqual(plan.RankIDs, []int64{1}) {
		t.Fatalf("expected rank ids [1], got %v", plan.RankIDs)
	}
	assertFloatSlicesClose(t, plan.Ranks, []float64{(0.2 + 0.4 + 0.8) / 3})
}

func TestRelationshipDedupePlanner_MultiIterationPreservesTrueMean(t *testing.T) {
	planner := newRelationshipDedupePlanner([]pgdb.GetProjectRelationshipsRow{
		{ID: 1, SourceID: 10, TargetID: 20, Rank: 0.2},
		{ID: 2, SourceID: 10, TargetID: 20, Rank: 0.4},
		{ID: 3, SourceID: 30, TargetID: 40, Rank: 0.8},
	})

	planner.dedupeIteration()
	firstPlan := planner.buildPlan()
	planner.commitPlan(firstPlan)

	planner.applyEntityMerges([]appliedEntityMergeComponent{
		{CanonicalID: 10, DupeIDs: []int64{30}},
		{CanonicalID: 20, DupeIDs: []int64{40}},
	})
	planner.dedupeIteration()
	plan := planner.buildPlan()

	if !reflect.DeepEqual(plan.RelationshipIDs, []int64{3}) {
		t.Fatalf("expected duplicate relationship ids [3], got %v", plan.RelationshipIDs)
	}
	if !reflect.DeepEqual(plan.CanonicalIDs, []int64{1}) {
		t.Fatalf("expected canonical ids [1], got %v", plan.CanonicalIDs)
	}
	if !reflect.DeepEqual(plan.RankIDs, []int64{1}) {
		t.Fatalf("expected rank ids [1], got %v", plan.RankIDs)
	}
	assertFloatSlicesClose(t, plan.Ranks, []float64{(0.2 + 0.4 + 0.8) / 3})
}

func TestRelationshipDedupePlanner_CommitPlanClearsAppliedChanges(t *testing.T) {
	planner := newRelationshipDedupePlanner([]pgdb.GetProjectRelationshipsRow{
		{ID: 1, SourceID: 10, TargetID: 20, Rank: 0.2},
		{ID: 2, SourceID: 10, TargetID: 20, Rank: 0.4},
	})

	planner.dedupeIteration()
	plan := planner.buildPlan()
	planner.commitPlan(plan)

	committed := planner.buildPlan()
	if len(committed.RelationshipIDs) != 0 || len(committed.CanonicalIDs) != 0 ||
		len(committed.RankIDs) != 0 || len(committed.Ranks) != 0 || len(committed.DeleteIDs) != 0 {
		t.Fatalf("expected empty plan after commit, got %+v", committed)
	}
}

func TestRelationshipDedupePlanner_ResolvesCanonicalChains(t *testing.T) {
	planner := newRelationshipDedupePlanner([]pgdb.GetProjectRelationshipsRow{
		{ID: 5, SourceID: 10, TargetID: 20, Rank: 0.2},
		{ID: 6, SourceID: 10, TargetID: 20, Rank: 0.4},
		{ID: 4, SourceID: 30, TargetID: 40, Rank: 0.8},
	})

	planner.dedupeIteration()
	firstPlan := planner.buildPlan()
	planner.commitPlan(firstPlan)

	planner.applyEntityMerges([]appliedEntityMergeComponent{
		{CanonicalID: 10, DupeIDs: []int64{30}},
		{CanonicalID: 20, DupeIDs: []int64{40}},
	})
	planner.dedupeIteration()
	plan := planner.buildPlan()

	if !reflect.DeepEqual(plan.RelationshipIDs, []int64{5}) {
		t.Fatalf("expected duplicate relationship ids [5], got %v", plan.RelationshipIDs)
	}
	if !reflect.DeepEqual(plan.CanonicalIDs, []int64{4}) {
		t.Fatalf("expected canonical ids [4], got %v", plan.CanonicalIDs)
	}
	if !reflect.DeepEqual(plan.DeleteIDs, []int64{5}) {
		t.Fatalf("expected delete ids [5], got %v", plan.DeleteIDs)
	}
	if !reflect.DeepEqual(plan.RankIDs, []int64{4}) {
		t.Fatalf("expected rank ids [4], got %v", plan.RankIDs)
	}
	assertFloatSlicesClose(t, plan.Ranks, []float64{(0.2 + 0.4 + 0.8) / 3})
}

func assertFloatSlicesClose(t *testing.T, got, want []float64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("expected %d floats, got %d", len(want), len(got))
	}
	for i := range got {
		if math.Abs(got[i]-want[i]) > 1e-9 {
			t.Fatalf("expected float at index %d to be %v, got %v", i, want[i], got[i])
		}
	}
}
