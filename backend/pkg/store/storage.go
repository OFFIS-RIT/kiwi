package store

import (
	"context"

	"kiwi/pkg/ai"
	"kiwi/pkg/common"
	"kiwi/pkg/loader"
)

// GraphStorage defines the interface for persisting and querying knowledge graphs.
// It provides methods for CRUD operations on graph data (entities, relationships,
// units), context retrieval for AI queries, and maintenance operations like
// deduplication and description generation.
type GraphStorage interface {
	UpdateGraph(
		ctx context.Context,
		id string,
		newUnits []common.Unit,
		newEntities []common.Entity,
		updatedEntities []common.Entity,
		deletedEntities []common.Entity,
		newRelations []common.Relationship,
		updatedRelations []common.Relationship,
	) error
	DeleteGraph(ctx context.Context, id string) error

	GetLocalQueryContext(ctx context.Context, query string, embedding []float32, graphId string) (string, error)
	GetGlobalQueryContext(ctx context.Context, query string, embedding []float32, graphId string) (string, error)

	SaveUnits(ctx context.Context, units []*common.Unit) ([]int64, error)

	SaveEntities(ctx context.Context, entities []common.Entity, graphId string) ([]int64, error)

	SaveRelationships(ctx context.Context, relations []common.Relationship, graphId string) ([]int64, error)
	DedupeAndMergeEntities(ctx context.Context, graphID string, aiClient ai.GraphAIClient) error
	GenerateDescriptions(ctx context.Context, files []loader.GraphFile) error
	DeleteFilesAndRegenerateDescriptions(ctx context.Context, graphID string) error
	DeleteFile(ctx context.Context, fileID int64, projectID int64) error
	RollbackFileData(ctx context.Context, fileIDs []int64, projectID int64) error
	UpdateProjectProcessStep(ctx context.Context, projectID int64, step string) error
	UpdateProjectProcessPercentage(ctx context.Context, projectID int64, percentage int32) error
}
