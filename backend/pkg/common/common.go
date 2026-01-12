package common

// Graph represents a collection of entities, relationships, and text units.
// It serves as the central structure for graph analysis, capturing how
// entities are connected and contextualized.
//
// A graph contains:
//   - Entities: nodes in the graph representing concepts, people, organizations, etc.
//   - Relationships: directional edges between entities
//   - Units: the original text segments that provide provenance
type Graph struct {
	ID            string         `json:"id"`
	Entities      []Entity       `json:"entities"`
	Relationships []Relationship `json:"relationships"`
	Units         []*Unit        `json:"units"`
}

// Entity represents a node in the graph. An entity can be an organization,
// person, location, or any other relevant concept. Each entity may have
// multiple sources that provide descriptive information.
//
// Entities are typically enriched with AI-generated summaries that
// consolidate information from their sources.
type Entity struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Type        string   `json:"type"`
	Sources     []Source `json:"sources"`
}

// Source represents a provenance record for an entity or relationship.
// It links a description back to the original unit of text or data
// from which it was derived.
type Source struct {
	ID          string `json:"id"`
	Unit        *Unit  `json:"unit"`
	Description string `json:"description"`
}

// Relationship represents an edge between two entities in the graph.
// It describes how two entities are connected, along with supporting
// sources and a strength score.
//
// Relationships are directional, with a Source entity and a Target entity.
type Relationship struct {
	ID          string   `json:"id"`
	Source      *Entity  `json:"source"`
	Target      *Entity  `json:"target"`
	Description string   `json:"description"`
	Strength    float64  `json:"strength"`
	Sources     []Source `json:"sources"`
}

// Unit represents a contiguous segment of text extracted from a file.
// Units are the smallest building blocks in the graph and serve as the
// provenance for entities and relationships.
//
// Each unit is associated with a file, a character span, and the raw text
// content. Units are created by splitting documents into
// token-limited chunks for downstream AI processing.
type Unit struct {
	ID     string `json:"id"`
	FileID string `json:"file_id"`
	Start  int    `json:"start"`
	End    int    `json:"end"`
	Text   string `json:"text"`
}
