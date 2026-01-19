package graph

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/store"

	"golang.org/x/sync/errgroup"
)

func rollbackFiles(ctx context.Context, files []loader.GraphFile, graphID string, storeClient store.GraphStorage) {
	pid, err := strconv.ParseInt(graphID, 10, 64)
	if err != nil {
		return
	}

	// Extract unique file IDs from the files
	fileIDSet := make(map[int64]struct{})
	for _, file := range files {
		fileID := file.ID
		// Handle sheet IDs (e.g., "123-sheet-0" -> "123")
		if idx := strings.Index(fileID, "-sheet-"); idx != -1 {
			fileID = fileID[:idx]
		}
		fid, err := strconv.ParseInt(fileID, 10, 64)
		if err != nil {
			continue
		}
		fileIDSet[fid] = struct{}{}
	}

	if len(fileIDSet) == 0 {
		return
	}

	fileIDs := make([]int64, 0, len(fileIDSet))
	for fid := range fileIDSet {
		fileIDs = append(fileIDs, fid)
	}

	const maxRetries = 3
	for attempt := 1; attempt <= maxRetries; attempt++ {
		err := storeClient.RollbackFileData(ctx, fileIDs, pid)
		if err == nil {
			return
		}
		if attempt == maxRetries {
			return
		}
	}
}

// ProcessGraph builds or updates a knowledge graph from the provided files.
// It processes files in parallel, extracts entities and relationships,
// performs deduplication, and stores the results using the provided storage client.
func (g *GraphClient) ProcessGraph(
	ctx context.Context,
	files []loader.GraphFile,
	graphID string,
	aiClient ai.GraphAIClient,
	storeClient store.GraphStorage,
) error {
	return g.processFilesAndBuildGraph(ctx, files, graphID, aiClient, storeClient)
}

// DeleteGraph removes files from an existing graph and regenerates entity descriptions.
func (g *GraphClient) DeleteGraph(
	ctx context.Context,
	graphID string,
	aiClient ai.GraphAIClient,
	storeClient store.GraphStorage,
) error {
	logger.Info("[Graph] Deleting files from graph", "id", graphID)

	err := storeClient.DeleteFilesAndRegenerateDescriptions(ctx, graphID)
	if err != nil {
		return fmt.Errorf("failed to delete files and regenerate descriptions: %w", err)
	}

	logger.Info("[Graph] File deletion and description regeneration completed")

	return nil
}

// ExtractAndStage performs file extraction and document-level deduplication,
// then stages the results in the database. This phase does NOT require the project lock.
//
// Workers can run this in parallel for different batches. After extraction completes,
// the worker should acquire the project lock and call MergeFromStaging.
func (g *GraphClient) ExtractAndStage(
	ctx context.Context,
	files []loader.GraphFile,
	graphID string,
	aiClient ai.GraphAIClient,
	storeClient store.GraphStorage,
	correlationID string,
	batchID int,
) error {
	projectID, err := strconv.ParseInt(graphID, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid graph ID: %w", err)
	}

	totalFiles := len(files)
	logger.Info("[Graph] Extracting and staging", "total_files", totalFiles, "graph_id", graphID, "batch_id", batchID)

	eg, gCtx := errgroup.WithContext(ctx)
	eg.SetLimit(g.parallelFiles)

	type fileResult struct {
		units     []*common.Unit
		entities  []common.Entity
		relations []common.Relationship
	}
	results := make([]fileResult, len(files))
	var resultsMu sync.Mutex

	for i, file := range files {
		idx := i
		f := file
		eg.Go(func() error {
			select {
			case <-gCtx.Done():
				return nil
			default:
				result, err := processFile(gCtx, f, g.tokenEncoder, aiClient, g.maxRetries)
				if err != nil {
					return fmt.Errorf("failed to process file %s: %w", f.ID, err)
				}

				dedupedEntities, dedupedRelations, err := g.dedupeEntitiesAndRelations(gCtx, result.entities, result.relations, aiClient)
				if err != nil {
					return fmt.Errorf("failed to dedupe document entities: %w", err)
				}

				resultsMu.Lock()
				results[idx] = fileResult{
					units:     result.units,
					entities:  dedupedEntities,
					relations: dedupedRelations,
				}
				resultsMu.Unlock()

				return nil
			}
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("extraction failed:\n%w", err)
	}

	var allUnits []*common.Unit
	var allEntities []common.Entity
	var allRelations []common.Relationship

	for _, r := range results {
		allUnits = append(allUnits, r.units...)
		allEntities = append(allEntities, r.entities...)
		allRelations = append(allRelations, r.relations...)
	}

	logger.Info("[Graph] Staging extraction results",
		"units", len(allUnits),
		"entities", len(allEntities),
		"relations", len(allRelations),
		"batch_id", batchID,
	)

	if err := storeClient.StageUnits(ctx, correlationID, batchID, projectID, allUnits); err != nil {
		return fmt.Errorf("failed to stage units: %w", err)
	}

	if err := storeClient.StageEntities(ctx, correlationID, batchID, projectID, allEntities); err != nil {
		return fmt.Errorf("failed to stage entities: %w", err)
	}

	if err := storeClient.StageRelationships(ctx, correlationID, batchID, projectID, allRelations); err != nil {
		return fmt.Errorf("failed to stage relationships: %w", err)
	}

	logger.Info("[Graph] Extraction and staging completed", "batch_id", batchID)

	return nil
}

// MergeFromStaging reads staged data from the database and merges it into the main
// graph tables. This phase REQUIRES the project lock to be held.
//
// After calling this method, the caller should also call storeClient.DeleteStagedData
// to clean up the staging table.
func (g *GraphClient) MergeFromStaging(
	ctx context.Context,
	files []loader.GraphFile,
	graphID string,
	aiClient ai.GraphAIClient,
	storeClient store.GraphStorage,
	correlationID string,
	batchID int,
) error {
	logger.Info("[Graph] Merging from staging", "graph_id", graphID, "batch_id", batchID)

	units, err := storeClient.GetStagedUnits(ctx, correlationID, batchID)
	if err != nil {
		return fmt.Errorf("failed to get staged units: %w", err)
	}

	entities, err := storeClient.GetStagedEntities(ctx, correlationID, batchID)
	if err != nil {
		return fmt.Errorf("failed to get staged entities: %w", err)
	}

	relations, err := storeClient.GetStagedRelationships(ctx, correlationID, batchID)
	if err != nil {
		return fmt.Errorf("failed to get staged relationships: %w", err)
	}

	logger.Info("[Graph] Retrieved staged data",
		"units", len(units),
		"entities", len(entities),
		"relations", len(relations),
		"batch_id", batchID,
	)
	logger.Info("[Graph] Saving staged data to main tables")

	_, err = storeClient.SaveUnits(ctx, units)
	if err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to save units: %w", err)
	}

	_, err = storeClient.SaveEntities(ctx, entities, graphID)
	if err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to save entities: %w", err)
	}

	_, err = storeClient.SaveRelationships(ctx, relations, graphID)
	if err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to save relationships: %w", err)
	}

	logger.Info("[Graph] Data saved and merged, starting cross-document deduplication")

	err = storeClient.DedupeAndMergeEntities(ctx, graphID, aiClient)
	if err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to dedupe entities in DB: %w", err)
	}

	logger.Info("[Graph] Cross-document deduplication completed")
	logger.Info("[Graph] Starting description generation")

	err = storeClient.GenerateDescriptions(ctx, files)
	if err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to generate descriptions: %w", err)
	}

	logger.Info("[Graph] Descriptions generated")
	logger.Info("[Graph] Merge from staging completed", "batch_id", batchID)

	return nil
}

func (g *GraphClient) processFilesAndBuildGraph(
	ctx context.Context,
	files []loader.GraphFile,
	graphID string,
	aiClient ai.GraphAIClient,
	storeClient store.GraphStorage,
) error {
	eg, gCtx := errgroup.WithContext(ctx)
	eg.SetLimit(g.parallelFiles)
	mutex := sync.Mutex{}

	totalFiles := len(files)

	logger.Info("[Graph] Processing", "total_files", totalFiles, "graph_id", graphID)

	totalUnits := 0
	for _, file := range files {
		units, err := getUnitsFromText(ctx, file, g.tokenEncoder)
		if err == nil {
			totalUnits += len(units)
		}
	}

	for _, file := range files {
		f := file
		eg.Go(func() error {
			select {
			case <-gCtx.Done():
				return nil
			default:
				result, err := processFile(gCtx, f, g.tokenEncoder, aiClient, g.maxRetries)
				if err != nil {
					return err
				}

				dedupedEntities, dedupedRelations, err := g.dedupeEntitiesAndRelations(gCtx, result.entities, result.relations, aiClient)
				if err != nil {
					return fmt.Errorf("failed to dedupe document entities: %w", err)
				}

				mutex.Lock()
				defer mutex.Unlock()

				_, err = storeClient.SaveUnits(gCtx, result.units)
				if err != nil {
					return fmt.Errorf("failed to save units: %w", err)
				}

				_, err = storeClient.SaveEntities(gCtx, dedupedEntities, graphID)
				if err != nil {
					return fmt.Errorf("failed to save entities: %w", err)
				}

				_, err = storeClient.SaveRelationships(gCtx, dedupedRelations, graphID)
				if err != nil {
					return fmt.Errorf("failed to save relationships: %w", err)
				}

				return nil
			}
		})
	}

	if err := eg.Wait(); err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to process files:\n%w", err)
	}

	logger.Info("[Graph] Files processed")
	logger.Info("[Graph] Starting cross-document deduplication")

	err := storeClient.DedupeAndMergeEntities(ctx, graphID, aiClient)
	if err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to dedupe entities in DB: %w", err)
	}

	logger.Info("[Graph] Cross-document deduplication completed")
	logger.Info("[Graph] Starting description generation")

	err = storeClient.GenerateDescriptions(ctx, files)
	if err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to generate descriptions: %w", err)
	}

	logger.Info("[Graph] Descriptions generated")
	logger.Info("[Graph] Graph build completed")

	return nil
}
