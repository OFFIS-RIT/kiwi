package pgx

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/pgvector/pgvector-go"
	"golang.org/x/sync/errgroup"
)

const descriptionBatchSize = 100

type descriptionSource struct {
	ID          int64
	Description string
}

type entityDescriptionUpdate struct {
	ID          int64
	Description string
	Embedding   pgvector.Vector
}

type relationshipDescriptionUpdate struct {
	ID          int64
	Description string
	Embedding   pgvector.Vector
}

func (s *GraphDBStorage) GenerateEntityDescriptions(ctx context.Context, entityIDs []int64) error {
	if len(entityIDs) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	entities, err := q.GetProjectEntitiesByIDs(ctx, entityIDs)
	if err != nil {
		return err
	}

	logger.Debug("[Store] Generating entity descriptions", "count", len(entities))

	updates := make([]entityDescriptionUpdate, 0, len(entities))
	var updatesMu sync.Mutex

	eg, gCtx := errgroup.WithContext(ctx)
	for _, entity := range entities {
		ent := entity
		eg.Go(func() error {
			update, ok, err := s.buildEntityUpdateFromSources(gCtx, ent.ID, ent.Name, "", false)
			if err != nil || !ok {
				return err
			}
			updatesMu.Lock()
			updates = append(updates, update)
			updatesMu.Unlock()
			return nil
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to generate entity descriptions: %w", err)
	}
	if len(updates) == 0 {
		return nil
	}

	s.dbLock.Lock()
	err = s.updateEntitiesBatch(ctx, updates)
	s.dbLock.Unlock()
	if err != nil {
		return fmt.Errorf("failed to update entity descriptions: %w", err)
	}

	return nil
}

func (s *GraphDBStorage) GenerateRelationshipDescriptions(ctx context.Context, relationshipIDs []int64) error {
	if len(relationshipIDs) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	rels, err := q.GetProjectRelationshipsWithEntityNamesByIDs(ctx, relationshipIDs)
	if err != nil {
		return err
	}

	logger.Debug("[Store] Generating relationship descriptions", "count", len(rels))

	updates := make([]relationshipDescriptionUpdate, 0, len(rels))
	var updatesMu sync.Mutex

	eg, gCtx := errgroup.WithContext(ctx)
	for _, rel := range rels {
		r := rel
		eg.Go(func() error {
			relationName := fmt.Sprintf("%s -> %s", r.SourceName, r.TargetName)
			update, ok, err := s.buildRelationshipUpdateFromSources(gCtx, r.ID, relationName, "", false)
			if err != nil || !ok {
				return err
			}
			updatesMu.Lock()
			updates = append(updates, update)
			updatesMu.Unlock()
			return nil
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to generate relationship descriptions: %w", err)
	}
	if len(updates) == 0 {
		return nil
	}

	s.dbLock.Lock()
	err = s.updateRelationshipsBatch(ctx, updates)
	s.dbLock.Unlock()
	if err != nil {
		return fmt.Errorf("failed to update relationship descriptions: %w", err)
	}

	return nil
}

func (s *GraphDBStorage) UpdateEntityDescriptions(ctx context.Context, fileIDs []int64) error {
	if len(fileIDs) == 0 {
		return nil
	}

	projectID, err := s.getProjectIDFromFiles(ctx, fileIDs)
	if err != nil {
		return err
	}
	if projectID == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	entities, err := q.GetEntitiesWithSourcesFromFiles(ctx, pgdb.GetEntitiesWithSourcesFromFilesParams{
		Column1:   fileIDs,
		ProjectID: projectID,
	})
	if err != nil {
		return fmt.Errorf("failed to get entities: %w", err)
	}
	if len(entities) == 0 {
		return nil
	}

	entityIDs := make([]int64, len(entities))
	for i, entity := range entities {
		entityIDs[i] = entity.ID
	}

	return s.UpdateEntityDescriptionsByIDsFromFiles(ctx, entityIDs, fileIDs)
}

func (s *GraphDBStorage) UpdateRelationshipDescriptions(ctx context.Context, fileIDs []int64) error {
	if len(fileIDs) == 0 {
		return nil
	}

	projectID, err := s.getProjectIDFromFiles(ctx, fileIDs)
	if err != nil {
		return err
	}
	if projectID == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	rels, err := q.GetRelationshipsWithSourcesFromFiles(ctx, pgdb.GetRelationshipsWithSourcesFromFilesParams{
		Column1:   fileIDs,
		ProjectID: projectID,
	})
	if err != nil {
		return fmt.Errorf("failed to get relationships: %w", err)
	}
	if len(rels) == 0 {
		return nil
	}

	relIDs := make([]int64, len(rels))
	for i, rel := range rels {
		relIDs[i] = rel.ID
	}

	return s.UpdateRelationshipDescriptionsByIDsFromFiles(ctx, relIDs, fileIDs)
}

func (s *GraphDBStorage) UpdateEntityDescriptionsByIDsFromFiles(ctx context.Context, entityIDs []int64, fileIDs []int64) error {
	if len(entityIDs) == 0 || len(fileIDs) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	entities, err := q.GetProjectEntitiesByIDs(ctx, entityIDs)
	if err != nil {
		return err
	}

	entityByID := make(map[int64]pgdb.GetProjectEntitiesByIDsRow, len(entities))
	for _, entity := range entities {
		entityByID[entity.ID] = entity
	}

	updates := make([]entityDescriptionUpdate, 0, len(entityIDs))
	var updatesMu sync.Mutex

	eg, gCtx := errgroup.WithContext(ctx)
	for _, id := range entityIDs {
		entity, ok := entityByID[id]
		if !ok {
			continue
		}
		ent := entity
		eg.Go(func() error {
			update, ok, err := s.buildEntityUpdateFromSources(gCtx, ent.ID, ent.Name, ent.Description, true, fileIDs...)
			if err != nil || !ok {
				return err
			}
			updatesMu.Lock()
			updates = append(updates, update)
			updatesMu.Unlock()
			return nil
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to update entity descriptions: %w", err)
	}
	if len(updates) == 0 {
		return nil
	}

	s.dbLock.Lock()
	err = s.updateEntitiesBatch(ctx, updates)
	s.dbLock.Unlock()
	if err != nil {
		return fmt.Errorf("failed to update entity descriptions: %w", err)
	}

	return nil
}

func (s *GraphDBStorage) UpdateRelationshipDescriptionsByIDsFromFiles(ctx context.Context, relationshipIDs []int64, fileIDs []int64) error {
	if len(relationshipIDs) == 0 || len(fileIDs) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	rels, err := q.GetProjectRelationshipsWithEntityNamesByIDs(ctx, relationshipIDs)
	if err != nil {
		return err
	}

	relByID := make(map[int64]pgdb.GetProjectRelationshipsWithEntityNamesByIDsRow, len(rels))
	for _, rel := range rels {
		relByID[rel.ID] = rel
	}

	updates := make([]relationshipDescriptionUpdate, 0, len(relationshipIDs))
	var updatesMu sync.Mutex

	eg, gCtx := errgroup.WithContext(ctx)
	for _, id := range relationshipIDs {
		rel, ok := relByID[id]
		if !ok {
			continue
		}
		r := rel
		eg.Go(func() error {
			relationName := fmt.Sprintf("%s -> %s", r.SourceName, r.TargetName)
			update, ok, err := s.buildRelationshipUpdateFromSources(gCtx, r.ID, relationName, r.Description, true, fileIDs...)
			if err != nil || !ok {
				return err
			}
			updatesMu.Lock()
			updates = append(updates, update)
			updatesMu.Unlock()
			return nil
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to update relationship descriptions: %w", err)
	}
	if len(updates) == 0 {
		return nil
	}

	s.dbLock.Lock()
	err = s.updateRelationshipsBatch(ctx, updates)
	s.dbLock.Unlock()
	if err != nil {
		return fmt.Errorf("failed to update relationship descriptions: %w", err)
	}

	return nil
}

// DeleteFilesAndRegenerateDescriptions deletes files marked for deletion,
// cleans up orphaned entities/relationships, and regenerates descriptions
// for affected entities that still have remaining sources.
func (s *GraphDBStorage) DeleteFilesAndRegenerateDescriptions(
	ctx context.Context,
	graphID string,
) error {
	projectID, err := strconv.ParseInt(graphID, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid graph ID: %w", err)
	}

	q := pgdb.New(s.conn)

	deletedFiles, err := q.GetDeletedProjectFiles(ctx, projectID)
	if err != nil {
		return fmt.Errorf("failed to get deleted files: %w", err)
	}

	if len(deletedFiles) == 0 {
		logger.Debug("[Store] No files marked for deletion")
		return nil
	}

	logger.Debug("[Store] Processing files marked for deletion", "count", len(deletedFiles))

	fileIDs := make([]int64, len(deletedFiles))
	for i, file := range deletedFiles {
		fileIDs[i] = file.ID
	}

	unitRows, err := q.GetTextUnitIdsForFiles(ctx, fileIDs)
	if err != nil {
		return fmt.Errorf("failed to get text units for files: %w", err)
	}

	unitIDs := make([]int64, len(unitRows))
	for i, row := range unitRows {
		unitIDs[i] = row.ID
	}

	var affectedEntities []pgdb.GetEntitiesWithSourcesFromUnitsRow
	var affectedRelationships []pgdb.GetRelationshipsWithSourcesFromUnitsRow
	if len(unitIDs) > 0 {
		affectedEntities, err = q.GetEntitiesWithSourcesFromUnits(ctx, pgdb.GetEntitiesWithSourcesFromUnitsParams{
			Column1:   unitIDs,
			ProjectID: projectID,
		})
		if err != nil {
			return fmt.Errorf("failed to get affected entities: %w", err)
		}

		affectedRelationships, err = q.GetRelationshipsWithSourcesFromUnits(ctx, pgdb.GetRelationshipsWithSourcesFromUnitsParams{
			Column1:   unitIDs,
			ProjectID: projectID,
		})
		if err != nil {
			return fmt.Errorf("failed to get affected relationships: %w", err)
		}
	}

	logger.Debug("[Store] Found affected items", "entities", len(affectedEntities), "relationships", len(affectedRelationships))

	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	qtx := pgdb.New(s.conn).WithTx(tx)

	for _, file := range deletedFiles {
		err = qtx.DeleteProjectFile(ctx, file.ID)
		if err != nil {
			return fmt.Errorf("failed to delete file %d: %w", file.ID, err)
		}
	}

	err = qtx.DeleteEntitiesWithoutSources(ctx, projectID)
	if err != nil {
		return fmt.Errorf("failed to delete orphaned entities: %w", err)
	}

	err = qtx.DeleteRelationshipsWithoutSources(ctx, projectID)
	if err != nil {
		return fmt.Errorf("failed to delete orphaned relationships: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	logger.Debug("[Store] Deleted files and orphaned items, regenerating descriptions")

	entityIDs := make([]int64, 0, len(affectedEntities))
	for _, entity := range affectedEntities {
		entityIDs = append(entityIDs, entity.ID)
	}

	relationshipIDs := make([]int64, 0, len(affectedRelationships))
	for _, rel := range affectedRelationships {
		relationshipIDs = append(relationshipIDs, rel.ID)
	}

	eg, gCtx := errgroup.WithContext(ctx)
	if len(entityIDs) > 0 {
		ids := entityIDs
		eg.Go(func() error {
			return s.GenerateEntityDescriptions(gCtx, ids)
		})
	}
	if len(relationshipIDs) > 0 {
		ids := relationshipIDs
		eg.Go(func() error {
			return s.GenerateRelationshipDescriptions(gCtx, ids)
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to regenerate descriptions: %w", err)
	}

	logger.Debug("[Store] Description regeneration completed")

	return nil
}

func (s *GraphDBStorage) buildEntityUpdateFromSources(
	ctx context.Context,
	entityID int64,
	entityName string,
	currentDescription string,
	updateOnly bool,
	fileIDs ...int64,
) (entityDescriptionUpdate, bool, error) {
	fetch := func(ctx context.Context, lastID int64) ([]descriptionSource, error) {
		q := pgdb.New(s.conn)
		if len(fileIDs) == 0 {
			rows, err := q.GetEntitySourceDescriptionsBatch(ctx, pgdb.GetEntitySourceDescriptionsBatchParams{
				EntityID: entityID,
				ID:       lastID,
				Limit:    int32(descriptionBatchSize),
			})
			if err != nil {
				return nil, err
			}
			batch := make([]descriptionSource, len(rows))
			for i, row := range rows {
				batch[i] = descriptionSource{ID: row.ID, Description: row.Description}
			}
			return batch, nil
		}

		rows, err := q.GetEntitySourceDescriptionsForFilesBatch(ctx, pgdb.GetEntitySourceDescriptionsForFilesBatchParams{
			EntityID: entityID,
			Column2:  fileIDs,
			ID:       lastID,
			Limit:    int32(descriptionBatchSize),
		})
		if err != nil {
			return nil, err
		}
		batch := make([]descriptionSource, len(rows))
		for i, row := range rows {
			batch[i] = descriptionSource{ID: row.ID, Description: row.Description}
		}
		return batch, nil
	}

	description, ok, err := s.buildDescriptionFromSources(ctx, entityName, currentDescription, updateOnly, fetch)
	if err != nil || !ok {
		return entityDescriptionUpdate{}, ok, err
	}

	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(description))
	if err != nil {
		return entityDescriptionUpdate{}, false, err
	}

	return entityDescriptionUpdate{
		ID:          entityID,
		Description: description,
		Embedding:   pgvector.NewVector(embedding),
	}, true, nil
}

func (s *GraphDBStorage) buildRelationshipUpdateFromSources(
	ctx context.Context,
	relationshipID int64,
	relationName string,
	currentDescription string,
	updateOnly bool,
	fileIDs ...int64,
) (relationshipDescriptionUpdate, bool, error) {
	fetch := func(ctx context.Context, lastID int64) ([]descriptionSource, error) {
		q := pgdb.New(s.conn)
		if len(fileIDs) == 0 {
			rows, err := q.GetRelationshipSourceDescriptionsBatch(ctx, pgdb.GetRelationshipSourceDescriptionsBatchParams{
				RelationshipID: relationshipID,
				ID:             lastID,
				Limit:          int32(descriptionBatchSize),
			})
			if err != nil {
				return nil, err
			}
			batch := make([]descriptionSource, len(rows))
			for i, row := range rows {
				batch[i] = descriptionSource{ID: row.ID, Description: row.Description}
			}
			return batch, nil
		}

		rows, err := q.GetRelationshipSourceDescriptionsForFilesBatch(ctx, pgdb.GetRelationshipSourceDescriptionsForFilesBatchParams{
			RelationshipID: relationshipID,
			Column2:        fileIDs,
			ID:             lastID,
			Limit:          int32(descriptionBatchSize),
		})
		if err != nil {
			return nil, err
		}
		batch := make([]descriptionSource, len(rows))
		for i, row := range rows {
			batch[i] = descriptionSource{ID: row.ID, Description: row.Description}
		}
		return batch, nil
	}

	description, ok, err := s.buildDescriptionFromSources(ctx, relationName, currentDescription, updateOnly, fetch)
	if err != nil || !ok {
		return relationshipDescriptionUpdate{}, ok, err
	}

	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(description))
	if err != nil {
		return relationshipDescriptionUpdate{}, false, err
	}

	return relationshipDescriptionUpdate{
		ID:          relationshipID,
		Description: description,
		Embedding:   pgvector.NewVector(embedding),
	}, true, nil
}

func (s *GraphDBStorage) buildDescriptionFromSources(
	ctx context.Context,
	name string,
	currentDescription string,
	updateOnly bool,
	fetch func(ctx context.Context, lastID int64) ([]descriptionSource, error),
) (string, bool, error) {
	lastID := int64(0)
	processed := false

	for {
		if err := ctx.Err(); err != nil {
			return "", false, err
		}

		rows, err := fetch(ctx, lastID)
		if err != nil {
			return "", false, err
		}
		if len(rows) == 0 {
			break
		}

		isFirst := !processed
		processed = true

		batchDescriptions := make([]string, len(rows))
		for i, row := range rows {
			batchDescriptions[i] = row.Description
			lastID = row.ID
		}
		batchText := strings.Join(batchDescriptions, "\n\n")

		var prompt string
		if !updateOnly && isFirst {
			prompt = fmt.Sprintf(ai.DescPrompt, name, batchText)
		} else {
			prompt = fmt.Sprintf(ai.DescUpdatePrompt, name, currentDescription, batchText)
		}

		res, err := s.aiClient.GenerateCompletion(ctx, prompt)
		if err != nil {
			return "", false, err
		}

		currentDescription = normalizeDescriptionText(res)
	}

	return currentDescription, processed, nil
}

func (s *GraphDBStorage) updateEntitiesBatch(ctx context.Context, updates []entityDescriptionUpdate) error {
	if len(updates) == 0 {
		return nil
	}

	ids := make([]int64, len(updates))
	descriptions := make([]string, len(updates))
	embeddings := make([]pgvector.Vector, len(updates))
	for i, update := range updates {
		ids[i] = update.ID
		descriptions[i] = update.Description
		embeddings[i] = update.Embedding
	}

	q := pgdb.New(s.conn)
	return q.UpdateProjectEntitiesByIDs(ctx, pgdb.UpdateProjectEntitiesByIDsParams{
		Ids:          ids,
		Descriptions: descriptions,
		Embeddings:   embeddings,
	})
}

func (s *GraphDBStorage) updateRelationshipsBatch(ctx context.Context, updates []relationshipDescriptionUpdate) error {
	if len(updates) == 0 {
		return nil
	}

	ids := make([]int64, len(updates))
	descriptions := make([]string, len(updates))
	embeddings := make([]pgvector.Vector, len(updates))
	for i, update := range updates {
		ids[i] = update.ID
		descriptions[i] = update.Description
		embeddings[i] = update.Embedding
	}

	q := pgdb.New(s.conn)
	return q.UpdateProjectRelationshipsByIDs(ctx, pgdb.UpdateProjectRelationshipsByIDsParams{
		Ids:          ids,
		Descriptions: descriptions,
		Embeddings:   embeddings,
	})
}

func (s *GraphDBStorage) getProjectIDFromFiles(ctx context.Context, fileIDs []int64) (int64, error) {
	if len(fileIDs) == 0 {
		return 0, nil
	}

	q := pgdb.New(s.conn)
	projectIDs, err := q.GetProjectIDsForFiles(ctx, fileIDs)
	if err != nil {
		return 0, err
	}
	if len(projectIDs) == 0 {
		return 0, nil
	}
	if len(projectIDs) > 1 {
		return 0, fmt.Errorf("multiple project IDs found for files")
	}

	return projectIDs[0], nil
}

func normalizeDescriptionText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.TrimSpace(s)
	return strings.Join(strings.Fields(s), " ")
}
