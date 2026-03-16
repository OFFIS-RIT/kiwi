package graph

import (
	"context"
	"fmt"
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
	fileIDs := fileIDsFromGraphFiles(files)
	if len(fileIDs) == 0 {
		return
	}

	const maxRetries = 3
	for attempt := 1; attempt <= maxRetries; attempt++ {
		err := storeClient.RollbackFileData(ctx, fileIDs, graphID)
		if err == nil {
			return
		}
		if attempt == maxRetries {
			return
		}
	}
}

func fileIDsFromGraphFiles(files []loader.GraphFile) []string {
	fileIDSet := make(map[string]struct{})
	for _, file := range files {
		fileID := file.ID
		if idx := strings.Index(fileID, "-sheet-"); idx != -1 {
			fileID = fileID[:idx]
		}
		if fileID == "" {
			continue
		}
		fileIDSet[fileID] = struct{}{}
	}

	fileIDs := make([]string, 0, len(fileIDSet))
	for fid := range fileIDSet {
		fileIDs = append(fileIDs, fid)
	}

	return fileIDs
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

func (g *GraphClient) processFilesAndBuildGraph(
	ctx context.Context,
	files []loader.GraphFile,
	graphID string,
	aiClient ai.GraphAIClient,
	storeClient store.GraphStorage,
) error {
	eg, gCtx := errgroup.WithContext(ctx)
	eg.SetLimit(g.parallelFiles)

	type filePayload struct {
		units     []*common.Unit
		entities  []common.Entity
		relations []common.Relationship
	}

	totalFiles := len(files)

	logger.Info("[Graph] Processing", "total_files", totalFiles, "graph_id", graphID)

	totalUnits := 0
	for _, file := range files {
		units, err := getUnitsFromText(ctx, file)
		if err == nil {
			totalUnits += len(units)
		}
	}

	payloadCh := make(chan filePayload, g.parallelFiles)

	seedEntityIDs := make([]string, 0, totalFiles)
	eg.Go(func() error {
		for payload := range payloadCh {
			_, err := storeClient.SaveUnits(gCtx, payload.units)
			if err != nil {
				return fmt.Errorf("failed to save units: %w", err)
			}

			ids, err := storeClient.SaveEntities(gCtx, payload.entities, graphID)
			if err != nil {
				return fmt.Errorf("failed to save entities: %w", err)
			}
			seedEntityIDs = append(seedEntityIDs, ids...)

			_, err = storeClient.SaveRelationships(gCtx, payload.relations, graphID)
			if err != nil {
				return fmt.Errorf("failed to save relationships: %w", err)
			}
		}
		return nil
	})

	var wg sync.WaitGroup
	wg.Add(totalFiles)
	go func() {
		wg.Wait()
		close(payloadCh)
	}()

	for _, file := range files {
		f := file
		eg.Go(func() error {
			defer wg.Done()
			select {
			case <-gCtx.Done():
				return nil
			default:
				result, err := processFile(gCtx, f, aiClient, g.maxRetries)
				if err != nil {
					return err
				}

				dedupedEntities, dedupedRelations, err := g.dedupeEntitiesAndRelations(gCtx, result.entities, result.relations, aiClient)
				if err != nil {
					return fmt.Errorf("failed to dedupe document entities: %w", err)
				}

				payload := filePayload{units: result.units, entities: dedupedEntities, relations: dedupedRelations}
				select {
				case payloadCh <- payload:
					return nil
				case <-gCtx.Done():
					return nil
				}
			}
		})
	}

	if err := eg.Wait(); err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to process files:\n%w", err)
	}

	logger.Info("[Graph] Files processed")
	logger.Info("[Graph] Starting cross-document deduplication")

	if len(seedEntityIDs) > 0 {
		if err := storeClient.DedupeAndMergeEntities(ctx, graphID, aiClient, seedEntityIDs); err != nil {
			rollbackFiles(ctx, files, graphID, storeClient)
			return fmt.Errorf("failed to dedupe entities in DB: %w", err)
		}
		logger.Info("[Graph] Cross-document deduplication completed")
	} else {
		logger.Debug("[Graph] No new entities saved; skipping cross-document deduplication")
	}
	logger.Info("[Graph] Starting description generation")
	fileIDs := fileIDsFromGraphFiles(files)
	if err := storeClient.UpdateEntityDescriptions(ctx, fileIDs); err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to update entity descriptions: %w", err)
	}
	if err := storeClient.UpdateRelationshipDescriptions(ctx, fileIDs); err != nil {
		rollbackFiles(ctx, files, graphID, storeClient)
		return fmt.Errorf("failed to update relationship descriptions: %w", err)
	}

	logger.Info("[Graph] Descriptions generated")
	logger.Info("[Graph] Graph build completed")

	return nil
}
