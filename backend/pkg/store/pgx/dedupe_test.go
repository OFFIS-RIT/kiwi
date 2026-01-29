package pgx

import (
	"reflect"
	"testing"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
)

func TestPlanEntityMergeComponents_OverlappingGroups(t *testing.T) {
	entities := []entityWithMeta{
		{Entity: common.Entity{Name: "A", Type: "ORG"}, DBID: 1, SourceCount: 1},
		{Entity: common.Entity{Name: "B", Type: "ORG"}, DBID: 2, SourceCount: 5},
		{Entity: common.Entity{Name: "C", Type: "ORG"}, DBID: 3, SourceCount: 2},
	}
	res := &ai.DuplicatesResponse{Duplicates: []ai.DuplicateGroup{
		{Name: "B", Entities: []string{"A", "B"}},
		{Name: "B", Entities: []string{"B", "C"}},
	}}

	plan := planEntityMergeComponents(entities, res)
	if len(plan) != 1 {
		t.Fatalf("expected 1 merge component, got %d", len(plan))
	}
	if plan[0].CanonicalID != 2 {
		t.Fatalf("expected canonical id 2, got %d", plan[0].CanonicalID)
	}
	if !reflect.DeepEqual(plan[0].DupeIDs, []int64{1, 3}) {
		t.Fatalf("expected dupe ids [1 3], got %v", plan[0].DupeIDs)
	}
	if plan[0].CanonicalName != "B" {
		t.Fatalf("expected canonical name 'B', got %q", plan[0].CanonicalName)
	}
}

func TestPlanEntityMergeComponents_DisjointGroups(t *testing.T) {
	entities := []entityWithMeta{
		{Entity: common.Entity{Name: "A1", Type: "ORG"}, DBID: 1, SourceCount: 1},
		{Entity: common.Entity{Name: "A2", Type: "ORG"}, DBID: 2, SourceCount: 2},
		{Entity: common.Entity{Name: "D1", Type: "ORG"}, DBID: 3, SourceCount: 1},
		{Entity: common.Entity{Name: "D2", Type: "ORG"}, DBID: 4, SourceCount: 3},
	}
	res := &ai.DuplicatesResponse{Duplicates: []ai.DuplicateGroup{
		{Name: "A2", Entities: []string{"A1", "A2"}},
		{Name: "D2", Entities: []string{"D1", "D2"}},
	}}

	plan := planEntityMergeComponents(entities, res)
	if len(plan) != 2 {
		t.Fatalf("expected 2 merge components, got %d", len(plan))
	}

	if plan[0].CanonicalID != 2 || !reflect.DeepEqual(plan[0].DupeIDs, []int64{1}) || plan[0].CanonicalName != "A2" {
		t.Fatalf("unexpected plan[0]: %+v", plan[0])
	}
	if plan[1].CanonicalID != 4 || !reflect.DeepEqual(plan[1].DupeIDs, []int64{3}) || plan[1].CanonicalName != "D2" {
		t.Fatalf("unexpected plan[1]: %+v", plan[1])
	}
}

func TestPlanEntityMergeComponents_SameNameMapsToMultipleRows(t *testing.T) {
	entities := []entityWithMeta{
		{Entity: common.Entity{Name: "ACME", Type: "ORG"}, DBID: 1, SourceCount: 1},
		{Entity: common.Entity{Name: "ACME", Type: "ORG"}, DBID: 2, SourceCount: 2},
		{Entity: common.Entity{Name: "ACME CORP", Type: "ORG"}, DBID: 3, SourceCount: 3},
	}
	res := &ai.DuplicatesResponse{Duplicates: []ai.DuplicateGroup{
		{Name: "ACME CORP", Entities: []string{"ACME", "ACME CORP"}},
	}}

	plan := planEntityMergeComponents(entities, res)
	if len(plan) != 1 {
		t.Fatalf("expected 1 merge component, got %d", len(plan))
	}
	if plan[0].CanonicalID != 3 {
		t.Fatalf("expected canonical id 3, got %d", plan[0].CanonicalID)
	}
	if !reflect.DeepEqual(plan[0].DupeIDs, []int64{1, 2}) {
		t.Fatalf("expected dupe ids [1 2], got %v", plan[0].DupeIDs)
	}
	if plan[0].CanonicalName != "ACME CORP" {
		t.Fatalf("expected canonical name 'ACME CORP', got %q", plan[0].CanonicalName)
	}
}

func TestPlanEntityMergeComponents_RespectsType(t *testing.T) {
	entities := []entityWithMeta{
		{Entity: common.Entity{Name: "APPLE", Type: "ORG"}, DBID: 1, SourceCount: 10},
		{Entity: common.Entity{Name: "APPLE", Type: "PRODUCT"}, DBID: 2, SourceCount: 5},
		{Entity: common.Entity{Name: "APPLE INC", Type: "ORG"}, DBID: 3, SourceCount: 1},
	}
	res := &ai.DuplicatesResponse{Duplicates: []ai.DuplicateGroup{
		{Name: "APPLE INC", Entities: []string{"APPLE", "APPLE INC"}},
	}}

	plan := planEntityMergeComponents(entities, res)
	if len(plan) != 1 {
		t.Fatalf("expected 1 merge component, got %d", len(plan))
	}
	if plan[0].CanonicalID != 1 {
		t.Fatalf("expected canonical id 1, got %d", plan[0].CanonicalID)
	}
	if !reflect.DeepEqual(plan[0].DupeIDs, []int64{3}) {
		t.Fatalf("expected dupe ids [3], got %v", plan[0].DupeIDs)
	}
	if plan[0].CanonicalName != "APPLE INC" {
		t.Fatalf("expected canonical name 'APPLE INC', got %q", plan[0].CanonicalName)
	}
}

func TestPlanEntityMergeComponents_IgnoresUnknownNames(t *testing.T) {
	entities := []entityWithMeta{
		{Entity: common.Entity{Name: "A", Type: "ORG"}, DBID: 1, SourceCount: 1},
		{Entity: common.Entity{Name: "B", Type: "ORG"}, DBID: 2, SourceCount: 2},
	}
	res := &ai.DuplicatesResponse{Duplicates: []ai.DuplicateGroup{
		{Name: "B", Entities: []string{"A", "B", "C"}},
	}}

	plan := planEntityMergeComponents(entities, res)
	if len(plan) != 1 {
		t.Fatalf("expected 1 merge component, got %d", len(plan))
	}
	if plan[0].CanonicalID != 2 {
		t.Fatalf("expected canonical id 2, got %d", plan[0].CanonicalID)
	}
	if !reflect.DeepEqual(plan[0].DupeIDs, []int64{1}) {
		t.Fatalf("expected dupe ids [1], got %v", plan[0].DupeIDs)
	}
}

func TestPlanEntityMergeComponents_TieBreaksCanonicalByID(t *testing.T) {
	entities := []entityWithMeta{
		{Entity: common.Entity{Name: "X", Type: "ORG"}, DBID: 10, SourceCount: 1},
		{Entity: common.Entity{Name: "Y", Type: "ORG"}, DBID: 5, SourceCount: 1},
	}
	res := &ai.DuplicatesResponse{Duplicates: []ai.DuplicateGroup{
		{Name: "X", Entities: []string{"X", "Y"}},
	}}

	plan := planEntityMergeComponents(entities, res)
	if len(plan) != 1 {
		t.Fatalf("expected 1 merge component, got %d", len(plan))
	}
	if plan[0].CanonicalID != 5 {
		t.Fatalf("expected canonical id 5, got %d", plan[0].CanonicalID)
	}
	if !reflect.DeepEqual(plan[0].DupeIDs, []int64{10}) {
		t.Fatalf("expected dupe ids [10], got %v", plan[0].DupeIDs)
	}
	if plan[0].CanonicalName != "X" {
		t.Fatalf("expected canonical name 'X', got %q", plan[0].CanonicalName)
	}
}

func TestChooseCanonicalName_PrefersAIName(t *testing.T) {
	name := chooseCanonicalName([]string{"IBM"}, "International Business Machines")
	if name != "IBM" {
		t.Fatalf("expected 'IBM', got %q", name)
	}
}
