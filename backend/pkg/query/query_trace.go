package query

import (
	"slices"
	"sort"
	"sync"
)

type TraceEventKind string

const (
	TraceEventConsideredSourceIDs    TraceEventKind = "considered_source_ids"
	TraceEventUsedSourceIDs          TraceEventKind = "used_source_ids"
	TraceEventQueriedEntityIDs       TraceEventKind = "queried_entity_ids"
	TraceEventQueriedRelationshipIDs TraceEventKind = "queried_relationship_ids"
	TraceEventQueriedEntityTypes     TraceEventKind = "queried_entity_types"

	TraceEventToolCall TraceEventKind = "tool_call"
)

// TraceEvent is an extensible event envelope for query tracing.
// Additive changes to this struct are backward compatible for implementers.
type TraceEvent struct {
	Kind TraceEventKind

	SourceIDs       []string
	EntityIDs       []int64
	RelationshipIDs []int64
	EntityTypes     []string

	ToolName      string
	ToolArguments string
	DurationMs    int64
	Error         string
}

// Tracer is a sink for query tracing events.
//
// Implementers can forward events to logs, telemetry, or custom post-processing
// pipelines.
type Tracer interface {
	Record(event TraceEvent)
}

// MultiTracer fan-outs trace events to multiple tracers.
type MultiTracer []Tracer

func (m MultiTracer) Record(event TraceEvent) {
	for _, t := range m {
		if t == nil {
			continue
		}
		t.Record(event)
	}
}

func RecordConsideredSourceIDs(t Tracer, ids ...string) {
	if t == nil {
		return
	}
	t.Record(TraceEvent{Kind: TraceEventConsideredSourceIDs, SourceIDs: ids})
}

func RecordUsedSourceIDs(t Tracer, ids ...string) {
	if t == nil {
		return
	}
	t.Record(TraceEvent{Kind: TraceEventUsedSourceIDs, SourceIDs: ids})
}

func RecordQueriedEntityIDs(t Tracer, ids ...int64) {
	if t == nil {
		return
	}
	t.Record(TraceEvent{Kind: TraceEventQueriedEntityIDs, EntityIDs: ids})
}

func RecordQueriedRelationshipIDs(t Tracer, ids ...int64) {
	if t == nil {
		return
	}
	t.Record(TraceEvent{Kind: TraceEventQueriedRelationshipIDs, RelationshipIDs: ids})
}

func RecordQueriedEntityTypes(t Tracer, types ...string) {
	if t == nil {
		return
	}
	t.Record(TraceEvent{Kind: TraceEventQueriedEntityTypes, EntityTypes: types})
}

// QueryTrace collects information about what data was considered and/or used
// during a query run.
//
// This is primarily used to expose query metadata like "files considered" for
// both local and agentic query modes.
//
// QueryTrace is safe for concurrent use.
type QueryTrace struct {
	mu sync.Mutex

	consideredSourceIDs      map[string]struct{}
	usedSourceIDs            map[string]struct{}
	queriedEntityIDs         map[int64]struct{}
	queriedRelationshipIDs   map[int64]struct{}
	queriedEntityTypeFilters map[string]struct{}
}

type QueryTraceSnapshot struct {
	ConsideredSourceIDs    []string
	UsedSourceIDs          []string
	QueriedEntityIDs       []int64
	QueriedRelationshipIDs []int64
	QueriedEntityTypes     []string
}

func NewQueryTrace() *QueryTrace {
	return &QueryTrace{
		consideredSourceIDs:      make(map[string]struct{}),
		usedSourceIDs:            make(map[string]struct{}),
		queriedEntityIDs:         make(map[int64]struct{}),
		queriedRelationshipIDs:   make(map[int64]struct{}),
		queriedEntityTypeFilters: make(map[string]struct{}),
	}
}

func (t *QueryTrace) Record(event TraceEvent) {
	if t == nil {
		return
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	switch event.Kind {
	case TraceEventConsideredSourceIDs:
		for _, id := range event.SourceIDs {
			if id == "" {
				continue
			}
			t.consideredSourceIDs[id] = struct{}{}
		}
	case TraceEventUsedSourceIDs:
		for _, id := range event.SourceIDs {
			if id == "" {
				continue
			}
			t.usedSourceIDs[id] = struct{}{}
		}
	case TraceEventQueriedEntityIDs:
		for _, id := range event.EntityIDs {
			if id == 0 {
				continue
			}
			t.queriedEntityIDs[id] = struct{}{}
		}
	case TraceEventQueriedRelationshipIDs:
		for _, id := range event.RelationshipIDs {
			if id == 0 {
				continue
			}
			t.queriedRelationshipIDs[id] = struct{}{}
		}
	case TraceEventQueriedEntityTypes:
		for _, typ := range event.EntityTypes {
			if typ == "" {
				continue
			}
			t.queriedEntityTypeFilters[typ] = struct{}{}
		}
	default:
		return
	}
}

func (t *QueryTrace) Snapshot() QueryTraceSnapshot {
	if t == nil {
		return QueryTraceSnapshot{}
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	s := QueryTraceSnapshot{
		ConsideredSourceIDs:    make([]string, 0, len(t.consideredSourceIDs)),
		UsedSourceIDs:          make([]string, 0, len(t.usedSourceIDs)),
		QueriedEntityIDs:       make([]int64, 0, len(t.queriedEntityIDs)),
		QueriedRelationshipIDs: make([]int64, 0, len(t.queriedRelationshipIDs)),
		QueriedEntityTypes:     make([]string, 0, len(t.queriedEntityTypeFilters)),
	}

	for id := range t.consideredSourceIDs {
		s.ConsideredSourceIDs = append(s.ConsideredSourceIDs, id)
	}
	for id := range t.usedSourceIDs {
		s.UsedSourceIDs = append(s.UsedSourceIDs, id)
	}
	for id := range t.queriedEntityIDs {
		s.QueriedEntityIDs = append(s.QueriedEntityIDs, id)
	}
	for id := range t.queriedRelationshipIDs {
		s.QueriedRelationshipIDs = append(s.QueriedRelationshipIDs, id)
	}
	for typ := range t.queriedEntityTypeFilters {
		s.QueriedEntityTypes = append(s.QueriedEntityTypes, typ)
	}

	sort.Strings(s.ConsideredSourceIDs)
	sort.Strings(s.UsedSourceIDs)
	slices.Sort(s.QueriedEntityIDs)
	slices.Sort(s.QueriedRelationshipIDs)
	sort.Strings(s.QueriedEntityTypes)

	return s
}
