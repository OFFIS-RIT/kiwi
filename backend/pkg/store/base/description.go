package base

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"

	"github.com/pgvector/pgvector-go"
	"golang.org/x/sync/errgroup"
)

const descriptionBatchSize = 100

// GenerateDescriptions generates descriptions for entities and relationships
// that have new sources from the given files.
func (s *GraphDBStorage) GenerateDescriptions(
	ctx context.Context,
	files []loader.GraphFile,
) error {
	if len(files) == 0 {
		return nil
	}

	fileIDs := make([]int64, 0, len(files))
	for _, f := range files {
		fileID := f.ID
		if idx := strings.Index(fileID, "-sheet-"); idx != -1 {
			fileID = fileID[:idx]
		}
		fid, err := strconv.ParseInt(fileID, 10, 64)
		if err != nil {
			continue
		}
		fileIDs = append(fileIDs, fid)
	}

	if len(fileIDs) == 0 {
		return nil
	}

	q := db.New(s.conn)
	unitRows, err := q.GetTextUnitIdsForFiles(ctx, fileIDs)
	if err != nil {
		return fmt.Errorf("failed to get text units for files: %w", err)
	}

	unitIDs := make([]int64, len(unitRows))
	for i, row := range unitRows {
		unitIDs[i] = row.ID
	}

	if len(unitIDs) == 0 {
		return nil
	}

	projectID, err := q.GetProjectIDFromTextUnit(ctx, unitRows[0].PublicID)
	if err != nil {
		return fmt.Errorf("failed to get project ID: %w", err)
	}

	entities, err := q.GetEntitiesWithSourcesFromUnits(ctx, db.GetEntitiesWithSourcesFromUnitsParams{
		Column1:   unitIDs,
		ProjectID: projectID,
	})
	if err != nil {
		return fmt.Errorf("failed to get entities: %w", err)
	}

	logger.Debug("[Store] Generating entity descriptions", "count", len(entities))

	eg, gCtx := errgroup.WithContext(ctx)
	for _, entity := range entities {
		ent := entity
		eg.Go(func() error {
			return s.generateEntityDescription(gCtx, ent.ID, ent.Name, unitIDs)
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to generate entity descriptions: %w", err)
	}

	relationships, err := q.GetRelationshipsWithSourcesFromUnits(ctx, db.GetRelationshipsWithSourcesFromUnitsParams{
		Column1:   unitIDs,
		ProjectID: projectID,
	})
	if err != nil {
		return fmt.Errorf("failed to get relationships: %w", err)
	}

	logger.Debug("[Store] Generating relationship descriptions", "count", len(relationships))

	eg, gCtx = errgroup.WithContext(ctx)
	for _, rel := range relationships {
		r := rel
		eg.Go(func() error {
			return s.generateRelationshipDescription(gCtx, r.ID, r.SourceID, r.TargetID, unitIDs)
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to generate relationship descriptions: %w", err)
	}

	return nil
}

// generateEntityDescription generates and saves description for a single entity
func (s *GraphDBStorage) generateEntityDescription(
	ctx context.Context,
	entityID int64,
	entityName string,
	newUnitIDs []int64,
) error {
	q := db.New(s.conn)

	newSourceCount, err := q.CountEntitySourcesFromUnits(ctx, db.CountEntitySourcesFromUnitsParams{
		EntityID: entityID,
		Column2:  newUnitIDs,
	})
	if err != nil {
		return err
	}

	if newSourceCount == 0 {
		return nil
	}

	sources, err := q.GetAllEntitySourceDescriptions(ctx, entityID)
	if err != nil {
		return err
	}

	descriptions := make([]string, len(sources))
	for i, src := range sources {
		descriptions[i] = src.Description
	}

	description, err := s.generateDescription(ctx, descriptions, entityName)
	if err != nil {
		return err
	}

	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(description))
	if err != nil {
		return err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	_, err = q.UpdateProjectEntityByID(ctx, db.UpdateProjectEntityByIDParams{
		ID:          entityID,
		Description: description,
		Embedding:   embed,
	})
	s.dbLock.Unlock()

	return err
}

// generateRelationshipDescription generates and saves description for a single relationship
func (s *GraphDBStorage) generateRelationshipDescription(
	ctx context.Context,
	relationshipID int64,
	sourceEntityID int64,
	targetEntityID int64,
	newUnitIDs []int64,
) error {
	q := db.New(s.conn)

	newSourceCount, err := q.CountRelationshipSourcesFromUnits(ctx, db.CountRelationshipSourcesFromUnitsParams{
		RelationshipID: relationshipID,
		Column2:        newUnitIDs,
	})
	if err != nil {
		return err
	}

	if newSourceCount == 0 {
		return nil
	}

	sources, err := q.GetAllRelationshipSourceDescriptions(ctx, relationshipID)
	if err != nil {
		return err
	}

	descriptions := make([]string, len(sources))
	for i, src := range sources {
		descriptions[i] = src.Description
	}

	sourceEntity, err := q.GetProjectEntityByID(ctx, sourceEntityID)
	if err != nil {
		return err
	}
	targetEntity, err := q.GetProjectEntityByID(ctx, targetEntityID)
	if err != nil {
		return err
	}

	relationName := fmt.Sprintf("%s -> %s", sourceEntity.Name, targetEntity.Name)

	description, err := s.generateDescription(ctx, descriptions, relationName)
	if err != nil {
		return err
	}

	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(description))
	if err != nil {
		return err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	_, err = q.UpdateProjectRelationshipByID(ctx, db.UpdateProjectRelationshipByIDParams{
		ID:          relationshipID,
		Description: description,
		Embedding:   embed,
	})
	s.dbLock.Unlock()

	return err
}

// generateDescription calls AI to generate a consolidated description
// It processes descriptions in batches to avoid exceeding LLM token limits.
// For the first batch, it uses DescPrompt to generate an initial description.
// For subsequent batches, it uses DescUpdatePrompt to merge new information.
func (s *GraphDBStorage) generateDescription(
	ctx context.Context,
	descriptions []string,
	name string,
) (string, error) {
	if len(descriptions) == 0 {
		return "", nil
	}

	var currentDescription string

	for i := 0; i < len(descriptions); i += descriptionBatchSize {
		end := min(i+descriptionBatchSize, len(descriptions))
		batch := descriptions[i:end]
		batchText := strings.Join(batch, "\n\n")

		var prompt string
		if i == 0 {
			prompt = fmt.Sprintf(ai.DescPrompt, name, batchText)
		} else {
			prompt = fmt.Sprintf(ai.DescUpdatePrompt, name, currentDescription, batchText)
		}

		res, err := s.aiClient.GenerateCompletion(ctx, prompt)
		if err != nil {
			return "", err
		}

		currentDescription = normalizeDescriptionText(res)
	}

	return currentDescription, nil
}

func normalizeDescriptionText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.TrimSpace(s)
	return strings.Join(strings.Fields(s), " ")
}

// mergeDescriptionIntoCurrent merges new descriptive segments into an existing description.
// If currentDescription is empty, it falls back to generating a fresh description from new segments.
func (s *GraphDBStorage) mergeDescriptionIntoCurrent(
	ctx context.Context,
	name string,
	currentDescription string,
	newDescriptions []string,
) (string, error) {
	if len(newDescriptions) == 0 {
		return currentDescription, nil
	}

	currentDescription = strings.TrimSpace(currentDescription)
	if currentDescription == "" {
		return s.generateDescription(ctx, newDescriptions, name)
	}

	for i := 0; i < len(newDescriptions); i += descriptionBatchSize {
		end := min(i+descriptionBatchSize, len(newDescriptions))
		batch := newDescriptions[i:end]
		batchText := strings.Join(batch, "\n\n")

		prompt := fmt.Sprintf(ai.DescUpdatePrompt, name, currentDescription, batchText)
		res, err := s.aiClient.GenerateCompletion(ctx, prompt)
		if err != nil {
			return "", err
		}

		currentDescription = normalizeDescriptionText(res)
	}

	return currentDescription, nil
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

	q := db.New(s.conn)

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
	for i, f := range deletedFiles {
		fileIDs[i] = f.ID
	}

	unitRows, err := q.GetTextUnitIdsForFiles(ctx, fileIDs)
	if err != nil {
		return fmt.Errorf("failed to get text units for files: %w", err)
	}

	unitIDs := make([]int64, len(unitRows))
	for i, row := range unitRows {
		unitIDs[i] = row.ID
	}

	var affectedEntities []db.GetEntitiesWithSourcesFromUnitsRow
	var affectedRelationships []db.GetRelationshipsWithSourcesFromUnitsRow

	if len(unitIDs) > 0 {
		affectedEntities, err = q.GetEntitiesWithSourcesFromUnits(ctx, db.GetEntitiesWithSourcesFromUnitsParams{
			Column1:   unitIDs,
			ProjectID: projectID,
		})
		if err != nil {
			return fmt.Errorf("failed to get affected entities: %w", err)
		}

		affectedRelationships, err = q.GetRelationshipsWithSourcesFromUnits(ctx, db.GetRelationshipsWithSourcesFromUnitsParams{
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

	qtx := db.New(s.conn).WithTx(tx)

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

	eg, gCtx := errgroup.WithContext(ctx)
	for _, entity := range affectedEntities {
		ent := entity
		eg.Go(func() error {
			sources, err := q.GetAllEntitySourceDescriptions(gCtx, ent.ID)
			if err != nil || len(sources) == 0 {
				return nil
			}

			return s.regenerateEntityDescription(gCtx, ent.ID, ent.Name)
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to regenerate entity descriptions: %w", err)
	}

	eg, gCtx = errgroup.WithContext(ctx)
	for _, rel := range affectedRelationships {
		r := rel
		eg.Go(func() error {
			sources, err := q.GetAllRelationshipSourceDescriptions(gCtx, r.ID)
			if err != nil || len(sources) == 0 {
				return nil
			}

			return s.regenerateRelationshipDescription(gCtx, r.ID, r.SourceID, r.TargetID)
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("failed to regenerate relationship descriptions: %w", err)
	}

	logger.Debug("[Store] Description regeneration completed")

	return nil
}

// regenerateEntityDescription regenerates description for an entity using all its remaining sources
func (s *GraphDBStorage) regenerateEntityDescription(
	ctx context.Context,
	entityID int64,
	entityName string,
) error {
	q := db.New(s.conn)

	sources, err := q.GetAllEntitySourceDescriptions(ctx, entityID)
	if err != nil {
		return err
	}

	if len(sources) == 0 {
		return nil
	}

	descriptions := make([]string, len(sources))
	for i, src := range sources {
		descriptions[i] = src.Description
	}

	description, err := s.generateDescription(ctx, descriptions, entityName)
	if err != nil {
		return err
	}

	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(description))
	if err != nil {
		return err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	_, err = q.UpdateProjectEntityByID(ctx, db.UpdateProjectEntityByIDParams{
		ID:          entityID,
		Description: description,
		Embedding:   embed,
	})
	s.dbLock.Unlock()

	return err
}

// regenerateRelationshipDescription regenerates description for a relationship using all its remaining sources
func (s *GraphDBStorage) regenerateRelationshipDescription(
	ctx context.Context,
	relationshipID int64,
	sourceEntityID int64,
	targetEntityID int64,
) error {
	q := db.New(s.conn)

	sources, err := q.GetAllRelationshipSourceDescriptions(ctx, relationshipID)
	if err != nil {
		return err
	}

	if len(sources) == 0 {
		return nil
	}

	descriptions := make([]string, len(sources))
	for i, src := range sources {
		descriptions[i] = src.Description
	}

	sourceEntity, err := q.GetProjectEntityByID(ctx, sourceEntityID)
	if err != nil {
		return err
	}
	targetEntity, err := q.GetProjectEntityByID(ctx, targetEntityID)
	if err != nil {
		return err
	}

	relationName := fmt.Sprintf("%s -> %s", sourceEntity.Name, targetEntity.Name)

	description, err := s.generateDescription(ctx, descriptions, relationName)
	if err != nil {
		return err
	}

	embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(description))
	if err != nil {
		return err
	}
	embed := pgvector.NewVector(embedding)

	s.dbLock.Lock()
	_, err = q.UpdateProjectRelationshipByID(ctx, db.UpdateProjectRelationshipByIDParams{
		ID:          relationshipID,
		Description: description,
		Embedding:   embed,
	})
	s.dbLock.Unlock()

	return err
}

// RegenerateEntityDescriptionsByIDs regenerates descriptions for the provided entity IDs
// using all remaining sources for each entity.
func (s *GraphDBStorage) RegenerateEntityDescriptionsByIDs(ctx context.Context, entityIDs []int64) error {
	if len(entityIDs) == 0 {
		return nil
	}

	q := db.New(s.conn)
	entities, err := q.GetProjectEntitiesByIDs(ctx, entityIDs)
	if err != nil {
		return err
	}

	nameByID := make(map[int64]string, len(entities))
	for _, e := range entities {
		nameByID[e.ID] = e.Name
	}

	for _, id := range entityIDs {
		name, ok := nameByID[id]
		if !ok {
			continue
		}
		if err := s.regenerateEntityDescription(ctx, id, name); err != nil {
			return err
		}
	}

	return nil
}

// RegenerateRelationshipDescriptionsByIDs regenerates descriptions for the provided relationship IDs
// using all remaining sources for each relationship.
func (s *GraphDBStorage) RegenerateRelationshipDescriptionsByIDs(ctx context.Context, relationshipIDs []int64) error {
	if len(relationshipIDs) == 0 {
		return nil
	}

	q := db.New(s.conn)
	rels, err := q.GetProjectRelationshipsByIDs(ctx, relationshipIDs)
	if err != nil {
		return err
	}

	relByID := make(map[int64]db.GetProjectRelationshipsByIDsRow, len(rels))
	for _, r := range rels {
		relByID[r.ID] = r
	}

	for _, id := range relationshipIDs {
		r, ok := relByID[id]
		if !ok {
			continue
		}
		if err := s.regenerateRelationshipDescription(ctx, r.ID, r.SourceID, r.TargetID); err != nil {
			return err
		}
	}

	return nil
}

// UpdateEntityDescriptionsByIDsFromFiles updates entity descriptions by merging in only sources
// that come from the given file IDs.
func (s *GraphDBStorage) UpdateEntityDescriptionsByIDsFromFiles(ctx context.Context, entityIDs []int64, fileIDs []int64) error {
	if len(entityIDs) == 0 || len(fileIDs) == 0 {
		return nil
	}

	q := db.New(s.conn)
	entities, err := q.GetProjectEntitiesByIDs(ctx, entityIDs)
	if err != nil {
		return err
	}

	entityByID := make(map[int64]db.GetProjectEntitiesByIDsRow, len(entities))
	for _, e := range entities {
		entityByID[e.ID] = e
	}

	for _, id := range entityIDs {
		e, ok := entityByID[id]
		if !ok {
			continue
		}

		newDescriptions, err := q.GetEntitySourceDescriptionsForFiles(ctx, db.GetEntitySourceDescriptionsForFilesParams{
			EntityID: id,
			Column2:  fileIDs,
		})
		if err != nil {
			return err
		}
		if len(newDescriptions) == 0 {
			continue
		}

		updated, err := s.mergeDescriptionIntoCurrent(ctx, e.Name, e.Description, newDescriptions)
		if err != nil {
			return err
		}

		embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(updated))
		if err != nil {
			return err
		}
		embed := pgvector.NewVector(embedding)

		s.dbLock.Lock()
		_, err = q.UpdateProjectEntityByID(ctx, db.UpdateProjectEntityByIDParams{
			ID:          id,
			Description: updated,
			Embedding:   embed,
		})
		s.dbLock.Unlock()
		if err != nil {
			return err
		}
	}

	return nil
}

// UpdateRelationshipDescriptionsByIDsFromFiles updates relationship descriptions by merging in only sources
// that come from the given file IDs.
func (s *GraphDBStorage) UpdateRelationshipDescriptionsByIDsFromFiles(ctx context.Context, relationshipIDs []int64, fileIDs []int64) error {
	if len(relationshipIDs) == 0 || len(fileIDs) == 0 {
		return nil
	}

	q := db.New(s.conn)
	rels, err := q.GetProjectRelationshipsByIDs(ctx, relationshipIDs)
	if err != nil {
		return err
	}

	relByID := make(map[int64]db.GetProjectRelationshipsByIDsRow, len(rels))
	for _, r := range rels {
		relByID[r.ID] = r
	}

	for _, id := range relationshipIDs {
		r, ok := relByID[id]
		if !ok {
			continue
		}

		newDescriptions, err := q.GetRelationshipSourceDescriptionsForFiles(ctx, db.GetRelationshipSourceDescriptionsForFilesParams{
			RelationshipID: id,
			Column2:        fileIDs,
		})
		if err != nil {
			return err
		}
		if len(newDescriptions) == 0 {
			continue
		}

		sourceEntity, err := q.GetProjectEntityByID(ctx, r.SourceID)
		if err != nil {
			return err
		}
		targetEntity, err := q.GetProjectEntityByID(ctx, r.TargetID)
		if err != nil {
			return err
		}
		relationName := fmt.Sprintf("%s -> %s", sourceEntity.Name, targetEntity.Name)

		updated, err := s.mergeDescriptionIntoCurrent(ctx, relationName, r.Description, newDescriptions)
		if err != nil {
			return err
		}

		embedding, err := s.aiClient.GenerateEmbedding(ctx, []byte(updated))
		if err != nil {
			return err
		}
		embed := pgvector.NewVector(embedding)

		s.dbLock.Lock()
		_, err = q.UpdateProjectRelationshipByID(ctx, db.UpdateProjectRelationshipByIDParams{
			ID:          id,
			Description: updated,
			Embedding:   embed,
		})
		s.dbLock.Unlock()
		if err != nil {
			return err
		}
	}

	return nil
}
