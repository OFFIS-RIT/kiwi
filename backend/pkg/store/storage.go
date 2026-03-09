package store

import (
	"context"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
)

// GraphStorage defines the interface for persisting and querying knowledge graphs.
// It provides methods for CRUD operations on graph data (entities, relationships,
// units), context retrieval for AI queries, and maintenance operations like
// deduplication and description generation.
type GraphStorage interface {
	DeleteGraph(ctx context.Context, id string) error
	GetLocalQueryContext(ctx context.Context, query string, embedding []float32, graphId string) (string, error)

	SaveUnits(ctx context.Context, units []*common.Unit) ([]string, error)
	SaveEntities(ctx context.Context, entities []common.Entity, graphId string) ([]string, error)
	SaveRelationships(ctx context.Context, relations []common.Relationship, graphId string) ([]string, error)

	// DedupeAndMergeEntities finds and merges duplicate entities in the graph.
	//
	// The deduplication scope is anchored to the provided seedEntityIDs: only
	// similarity pairs involving at least one of these entity IDs are considered.
	// This is used in the processing pipeline to dedupe only entities extracted
	// in the current run/batch.
	DedupeAndMergeEntities(ctx context.Context, graphID string, aiClient ai.GraphAIClient, seedEntityIDs []string) error

	GenerateEntityDescriptions(ctx context.Context, entityIDs []string) error
	GenerateRelationshipDescriptions(ctx context.Context, relationshipIDs []string) error
	UpdateEntityDescriptions(ctx context.Context, fileIDs []string) error
	UpdateRelationshipDescriptions(ctx context.Context, fileIDs []string) error
	UpdateEntityDescriptionsByIDsFromFiles(ctx context.Context, entityIDs []string, fileIDs []string) error
	UpdateRelationshipDescriptionsByIDsFromFiles(ctx context.Context, relationshipIDs []string, fileIDs []string) error

	DeleteFilesAndRegenerateDescriptions(ctx context.Context, graphID string) error
	DeleteFile(ctx context.Context, fileID string, projectID string) error

	RollbackFileData(ctx context.Context, fileIDs []string, projectID string) error
}
