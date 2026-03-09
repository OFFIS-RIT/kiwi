package pgx

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pgvector/pgvector-go"
	"golang.org/x/sync/errgroup"
)

const descriptionBatchSize = 100

type descriptionSource struct {
	ID          string
	CreatedAt   pgtype.Timestamptz
	Description string
}

type entityDescriptionUpdate struct {
	ID          string
	Description string
	Embedding   pgvector.Vector
}

type relationshipDescriptionUpdate struct {
	ID          string
	Description string
	Embedding   pgvector.Vector
}

func (s *GraphDBStorage) GenerateEntityDescriptions(ctx context.Context, entityIDs []string) error {
	if len(entityIDs) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	entities, err := q.GetProjectEntitiesByIDs(ctx, entityIDs)
	if err != nil {
		return err
	}

	logger.Debug("[Store] Generating entity descriptions", "count", len(entities))

	updates := make([]entityDescriptionUpdate, len(entities))
	hasUpdate := make([]bool, len(entities))

	eg, gCtx := errgroup.WithContext(ctx)
	eg.SetLimit(descriptionParallelismLimit())
	for i, entity := range entities {
		index := i
		ent := entity
		eg.Go(func() error {
			update, ok, err := s.buildEntityUpdateFromSources(gCtx, ent.ID, ent.Name, "", false)
			if err != nil || !ok {
				return err
			}
			updates[index] = update
			hasUpdate[index] = true
			return nil
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to generate entity descriptions: %w", err)
	}
	updates = compactEntityDescriptionUpdates(updates, hasUpdate)
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

func (s *GraphDBStorage) GenerateRelationshipDescriptions(ctx context.Context, relationshipIDs []string) error {
	if len(relationshipIDs) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	rels, err := q.GetProjectRelationshipsWithEntityNamesByIDs(ctx, relationshipIDs)
	if err != nil {
		return err
	}

	logger.Debug("[Store] Generating relationship descriptions", "count", len(rels))

	updates := make([]relationshipDescriptionUpdate, len(rels))
	hasUpdate := make([]bool, len(rels))

	eg, gCtx := errgroup.WithContext(ctx)
	eg.SetLimit(descriptionParallelismLimit())
	for i, rel := range rels {
		index := i
		r := rel
		eg.Go(func() error {
			relationName := fmt.Sprintf("%s -> %s", r.SourceName, r.TargetName)
			update, ok, err := s.buildRelationshipUpdateFromSources(gCtx, r.ID, relationName, "", false)
			if err != nil || !ok {
				return err
			}
			updates[index] = update
			hasUpdate[index] = true
			return nil
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to generate relationship descriptions: %w", err)
	}
	updates = compactRelationshipDescriptionUpdates(updates, hasUpdate)
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

func (s *GraphDBStorage) UpdateEntityDescriptions(ctx context.Context, fileIDs []string) error {
	if len(fileIDs) == 0 {
		return nil
	}

	projectID, err := s.getProjectIDFromFiles(ctx, fileIDs)
	if err != nil {
		return err
	}
	if projectID == "" {
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

	entityIDs := make([]string, len(entities))
	for i, entity := range entities {
		entityIDs[i] = entity.ID
	}

	return s.UpdateEntityDescriptionsByIDsFromFiles(ctx, entityIDs, fileIDs)
}

func (s *GraphDBStorage) UpdateRelationshipDescriptions(ctx context.Context, fileIDs []string) error {
	if len(fileIDs) == 0 {
		return nil
	}

	projectID, err := s.getProjectIDFromFiles(ctx, fileIDs)
	if err != nil {
		return err
	}
	if projectID == "" {
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

	relIDs := make([]string, len(rels))
	for i, rel := range rels {
		relIDs[i] = rel.ID
	}

	return s.UpdateRelationshipDescriptionsByIDsFromFiles(ctx, relIDs, fileIDs)
}

func (s *GraphDBStorage) UpdateEntityDescriptionsByIDsFromFiles(ctx context.Context, entityIDs []string, fileIDs []string) error {
	if len(entityIDs) == 0 || len(fileIDs) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	entities, err := q.GetProjectEntitiesByIDs(ctx, entityIDs)
	if err != nil {
		return err
	}

	entityByID := make(map[string]pgdb.GetProjectEntitiesByIDsRow, len(entities))
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

func (s *GraphDBStorage) UpdateRelationshipDescriptionsByIDsFromFiles(ctx context.Context, relationshipIDs []string, fileIDs []string) error {
	if len(relationshipIDs) == 0 || len(fileIDs) == 0 {
		return nil
	}

	q := pgdb.New(s.conn)
	rels, err := q.GetProjectRelationshipsWithEntityNamesByIDs(ctx, relationshipIDs)
	if err != nil {
		return err
	}

	relByID := make(map[string]pgdb.GetProjectRelationshipsWithEntityNamesByIDsRow, len(rels))
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
	projectID := graphID

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

	fileIDs := make([]string, len(deletedFiles))
	for i, file := range deletedFiles {
		fileIDs[i] = file.ID
	}

	unitIDs, err := q.GetTextUnitIdsForFiles(ctx, fileIDs)
	if err != nil {
		return fmt.Errorf("failed to get text units for files: %w", err)
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
			return fmt.Errorf("failed to delete file %s: %w", file.ID, err)
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

	entityIDs := make([]string, 0, len(affectedEntities))
	for _, entity := range affectedEntities {
		entityIDs = append(entityIDs, entity.ID)
	}

	relationshipIDs := make([]string, 0, len(affectedRelationships))
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
	entityID string,
	entityName string,
	currentDescription string,
	updateOnly bool,
	fileIDs ...string,
) (entityDescriptionUpdate, bool, error) {
	fetch := func(ctx context.Context, cursor descriptionCursor) ([]descriptionSource, error) {
		q := pgdb.New(s.conn)
		if len(fileIDs) == 0 {
			rows, err := q.GetEntitySourceDescriptionsBatch(ctx, pgdb.GetEntitySourceDescriptionsBatchParams{
				EntityID:        entityID,
				CursorCreatedAt: cursor.CreatedAt,
				CursorID:        cursor.ID,
				BatchLimit:      int32(descriptionBatchSize),
			})
			if err != nil {
				return nil, err
			}
			batch := make([]descriptionSource, len(rows))
			for i, row := range rows {
				batch[i] = descriptionSource{ID: row.ID, CreatedAt: row.CreatedAt, Description: row.Description}
			}
			return batch, nil
		}

		rows, err := q.GetEntitySourceDescriptionsForFilesBatch(ctx, pgdb.GetEntitySourceDescriptionsForFilesBatchParams{
			EntityID:        entityID,
			FileIds:         fileIDs,
			CursorCreatedAt: cursor.CreatedAt,
			CursorID:        cursor.ID,
			BatchLimit:      int32(descriptionBatchSize),
		})
		if err != nil {
			return nil, err
		}
		batch := make([]descriptionSource, len(rows))
		for i, row := range rows {
			batch[i] = descriptionSource{ID: row.ID, CreatedAt: row.CreatedAt, Description: row.Description}
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
	relationshipID string,
	relationName string,
	currentDescription string,
	updateOnly bool,
	fileIDs ...string,
) (relationshipDescriptionUpdate, bool, error) {
	fetch := func(ctx context.Context, cursor descriptionCursor) ([]descriptionSource, error) {
		q := pgdb.New(s.conn)
		if len(fileIDs) == 0 {
			rows, err := q.GetRelationshipSourceDescriptionsBatch(ctx, pgdb.GetRelationshipSourceDescriptionsBatchParams{
				RelationshipID:  relationshipID,
				CursorCreatedAt: cursor.CreatedAt,
				CursorID:        cursor.ID,
				BatchLimit:      int32(descriptionBatchSize),
			})
			if err != nil {
				return nil, err
			}
			batch := make([]descriptionSource, len(rows))
			for i, row := range rows {
				batch[i] = descriptionSource{ID: row.ID, CreatedAt: row.CreatedAt, Description: row.Description}
			}
			return batch, nil
		}

		rows, err := q.GetRelationshipSourceDescriptionsForFilesBatch(ctx, pgdb.GetRelationshipSourceDescriptionsForFilesBatchParams{
			RelationshipID:  relationshipID,
			FileIds:         fileIDs,
			CursorCreatedAt: cursor.CreatedAt,
			CursorID:        cursor.ID,
			BatchLimit:      int32(descriptionBatchSize),
		})
		if err != nil {
			return nil, err
		}
		batch := make([]descriptionSource, len(rows))
		for i, row := range rows {
			batch[i] = descriptionSource{ID: row.ID, CreatedAt: row.CreatedAt, Description: row.Description}
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

type descriptionCursor struct {
	CreatedAt pgtype.Timestamptz
	ID        string
}

func (s *GraphDBStorage) buildDescriptionFromSources(
	ctx context.Context,
	name string,
	currentDescription string,
	updateOnly bool,
	fetch func(ctx context.Context, cursor descriptionCursor) ([]descriptionSource, error),
) (string, bool, error) {
	cursor := descriptionCursor{}
	processed := false

	for {
		if err := ctx.Err(); err != nil {
			return "", false, err
		}

		rows, err := fetch(ctx, cursor)
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
			cursor = descriptionCursor{CreatedAt: row.CreatedAt, ID: row.ID}
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

	ids := make([]string, len(updates))
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

	ids := make([]string, len(updates))
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

func descriptionParallelismLimit() int {
	return max(1, int(util.GetEnvNumeric("AI_PARALLEL_REQ", 15)))
}

func compactEntityDescriptionUpdates(updates []entityDescriptionUpdate, hasUpdate []bool) []entityDescriptionUpdate {
	result := make([]entityDescriptionUpdate, 0, len(updates))
	for i, update := range updates {
		if i < len(hasUpdate) && hasUpdate[i] {
			result = append(result, update)
		}
	}
	return result
}

func compactRelationshipDescriptionUpdates(updates []relationshipDescriptionUpdate, hasUpdate []bool) []relationshipDescriptionUpdate {
	result := make([]relationshipDescriptionUpdate, 0, len(updates))
	for i, update := range updates {
		if i < len(hasUpdate) && hasUpdate[i] {
			result = append(result, update)
		}
	}
	return result
}

func (s *GraphDBStorage) getProjectIDFromFiles(ctx context.Context, fileIDs []string) (string, error) {
	if len(fileIDs) == 0 {
		return "", nil
	}

	q := pgdb.New(s.conn)
	projectIDs, err := q.GetProjectIDsForFiles(ctx, fileIDs)
	if err != nil {
		return "", err
	}
	if len(projectIDs) == 0 {
		return "", nil
	}
	if len(projectIDs) > 1 {
		return "", fmt.Errorf("multiple project IDs found for files")
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
