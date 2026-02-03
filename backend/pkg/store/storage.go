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

	SaveUnits(ctx context.Context, units []*common.Unit) ([]int64, error)
	SaveEntities(ctx context.Context, entities []common.Entity, graphId string) ([]int64, error)
	SaveRelationships(ctx context.Context, relations []common.Relationship, graphId string) ([]int64, error)

	// DedupeAndMergeEntities finds and merges duplicate entities in the graph.
	//
	// The deduplication scope is anchored to the provided seedEntityIDs: only
	// similarity pairs involving at least one of these entity IDs are considered.
	// This is used in the processing pipeline to dedupe only entities extracted
	// in the current run/batch.
	DedupeAndMergeEntities(ctx context.Context, graphID string, aiClient ai.GraphAIClient, seedEntityIDs []int64) error

	GenerateEntityDescriptions(ctx context.Context, entityIDs []int64) error
	GenerateRelationshipDescriptions(ctx context.Context, relationshipIDs []int64) error
	UpdateEntityDescriptions(ctx context.Context, fileIDs []int64) error
	UpdateRelationshipDescriptions(ctx context.Context, fileIDs []int64) error
	UpdateEntityDescriptionsByIDsFromFiles(ctx context.Context, entityIDs []int64, fileIDs []int64) error
	UpdateRelationshipDescriptionsByIDsFromFiles(ctx context.Context, relationshipIDs []int64, fileIDs []int64) error

	DeleteFilesAndRegenerateDescriptions(ctx context.Context, graphID string) error
	DeleteFile(ctx context.Context, fileID int64, projectID int64) error

	RollbackFileData(ctx context.Context, fileIDs []int64, projectID int64) error

	StageUnits(ctx context.Context, correlationID string, batchID int, projectID int64, units []*common.Unit) error
	StageEntities(ctx context.Context, correlationID string, batchID int, projectID int64, entities []common.Entity) error
	StageRelationships(ctx context.Context, correlationID string, batchID int, projectID int64, relations []common.Relationship) error
	GetStagedUnits(ctx context.Context, correlationID string, batchID int) ([]*common.Unit, error)
	GetStagedEntities(ctx context.Context, correlationID string, batchID int) ([]common.Entity, error)
	GetStagedRelationships(ctx context.Context, correlationID string, batchID int) ([]common.Relationship, error)
	DeleteStagedData(ctx context.Context, correlationID string, batchID int) error
}
