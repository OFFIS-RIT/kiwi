package base

import (
	"context"
	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"strconv"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"

	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"
)

// UpdateGraph updates a knowledge graph with new, modified, and deleted data.
// It processes units, entities, and relationships in parallel within a single
// transaction. Sources are linked to their corresponding entities/relationships
// after the primary records are created.
func (s *GraphDBStorage) UpdateGraph(
	ctx context.Context,
	id string,
	newUnits []common.Unit,
	newEntities []common.Entity,
	updatedEntities []common.Entity,
	deletedEntities []common.Entity,
	newRelations []common.Relationship,
	updatedRelations []common.Relationship,
) error {
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	q := db.New(s.conn)
	qtx := q.WithTx(tx)

	projectId, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return err
	}

	unitIdMap := make(map[string]int64)
	unitMu := sync.Mutex{}

	g, gCtx := errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for _, unit := range newUnits {
		u := unit
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return nil
			default:
				uId, err := s.AddUnit(gCtx, qtx, &u)
				if err != nil {
					return err
				}
				unitMu.Lock()
				unitIdMap[u.ID] = uId
				unitMu.Unlock()
				return nil
			}
		})
	}

	if err := g.Wait(); err != nil {
		return err
	}

	entityIdMap := make(map[string]int64, 0)
	entityMu := sync.Mutex{}
	newEntitySources := make(map[int64][]common.Source, 0)
	newEntitySourceMu := sync.Mutex{}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for _, entity := range newEntities {
		e := entity
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return nil
			default:
				eId, err := s.AddEntity(gCtx, qtx, &e, projectId)
				if err != nil {
					return err
				}

				entityMu.Lock()
				entityIdMap[e.ID] = eId
				entityMu.Unlock()

				for _, source := range e.Sources {
					newEntitySourceMu.Lock()
					newEntitySources[eId] = append(newEntitySources[eId], source)
					newEntitySourceMu.Unlock()
				}

				return nil
			}
		})
	}

	if err := g.Wait(); err != nil {
		return err
	}

	updatedEntitySources := make(map[int64][]common.Source, 0)
	updatedEntitySourceMu := sync.Mutex{}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for _, entity := range updatedEntities {
		e := entity
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return nil
			default:
				eId, err := s.UpdateEntityByPublicID(gCtx, qtx, e)
				if err != nil {
					return err
				}

				entityMu.Lock()
				entityIdMap[e.ID] = eId
				entityMu.Unlock()

				for _, source := range e.Sources {
					updatedEntitySourceMu.Lock()
					updatedEntitySources[eId] = append(updatedEntitySources[eId], source)
					updatedEntitySourceMu.Unlock()
				}

				return nil
			}
		})
	}

	if err := g.Wait(); err != nil {
		return err
	}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for _, entity := range deletedEntities {
		e := entity
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return nil
			default:
				s.dbLock.Lock()
				err := qtx.DeleteProjectEntityByPublicID(gCtx, e.ID)
				s.dbLock.Unlock()
				if err != nil {
					return err
				}
				return nil
			}
		})
	}

	if err := g.Wait(); err != nil {
		return err
	}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for eId, srcs := range newEntitySources {
		for _, source := range srcs {
			src := source
			entityId := eId
			g.Go(func() error {
				select {
				case <-ctx.Done():
					return nil
				default:
					unitMu.Lock()
					uId, ok := unitIdMap[src.Unit.ID]
					unitMu.Unlock()
					if !ok {
						return nil
					}
					_, err := s.AddEntitySource(gCtx, qtx, &src, entityId, uId)
					if err != nil {
						return err
					}
					return nil
				}
			})
		}
	}

	if err := g.Wait(); err != nil {
		return err
	}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for eId, srcs := range updatedEntitySources {
		for _, source := range srcs {
			src := source
			entityId := eId
			g.Go(func() error {
				select {
				case <-ctx.Done():
					return nil
				default:
					unitMu.Lock()
					uId, ok := unitIdMap[src.Unit.ID]
					unitMu.Unlock()
					if !ok {
						return nil
					}
					_, err := s.AddEntitySource(gCtx, qtx, &src, entityId, uId)
					if err != nil {
						return err
					}
					return nil
				}
			})
		}
	}

	if err := g.Wait(); err != nil {
		return err
	}

	newRelationSources := make(map[int64][]common.Source, 0)
	newRelationSourceMu := sync.Mutex{}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for _, relation := range newRelations {
		r := relation
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return nil
			default:
				entityMu.Lock()
				sId, ok1 := entityIdMap[r.Source.ID]
				tId, ok2 := entityIdMap[r.Target.ID]
				entityMu.Unlock()

				if !ok1 || !ok2 {
					return nil
				}

				rId, err := s.AddRelationship(gCtx, qtx, &r, projectId, sId, tId)
				if err != nil {
					return err
				}

				for _, source := range r.Sources {
					newRelationSourceMu.Lock()
					newRelationSources[rId] = append(newRelationSources[rId], source)
					newRelationSourceMu.Unlock()
				}

				return nil
			}
		})
	}

	if err := g.Wait(); err != nil {
		return err
	}

	updatedRelationSources := make(map[int64][]common.Source, 0)
	updatedRelationSourceMu := sync.Mutex{}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for _, relation := range updatedRelations {
		r := relation
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return nil
			default:
				rId, err := s.UpdateRelationshipByPublicID(gCtx, qtx, r)
				if err != nil {
					return err
				}

				for _, source := range r.Sources {
					updatedRelationSourceMu.Lock()
					updatedRelationSources[rId] = append(updatedRelationSources[rId], source)
					updatedRelationSourceMu.Unlock()
				}

				return nil
			}
		})
	}

	if err := g.Wait(); err != nil {
		return err
	}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)
	for rId, srcs := range newRelationSources {
		for _, source := range srcs {
			src := source
			relationId := rId
			g.Go(func() error {
				select {
				case <-ctx.Done():
					return nil
				default:
					unitMu.Lock()
					uId, ok := unitIdMap[src.Unit.ID]
					unitMu.Unlock()
					if !ok {
						return nil
					}
					_, err := s.AddRelationshipSource(gCtx, qtx, &src, relationId, uId)
					if err != nil {
						return err
					}
					return nil
				}
			})
		}
	}

	if err := g.Wait(); err != nil {
		return err
	}

	g, gCtx = errgroup.WithContext(ctx)
	g.SetLimit(s.maxParallel)

	for rId, srcs := range updatedRelationSources {
		for _, source := range srcs {
			src := source
			relationId := rId
			g.Go(func() error {
				select {
				case <-ctx.Done():
					return nil
				default:
					unitMu.Lock()
					uId, ok := unitIdMap[src.Unit.ID]
					unitMu.Unlock()
					if !ok {
						return nil
					}
					_, err := s.AddRelationshipSource(gCtx, qtx, &src, relationId, uId)
					if err != nil {
						return err
					}
					return nil
				}
			})
		}
	}

	if err := g.Wait(); err != nil {
		return err
	}

	err = tx.Commit(ctx)
	if err != nil {
		return err
	}

	return nil
}

// DeleteGraph removes an entire knowledge graph and all associated data
// (entities, relationships, sources, text units) from the database.
func (s *GraphDBStorage) DeleteGraph(ctx context.Context, graphID string) error {
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	q := db.New(s.conn)
	qtx := q.WithTx(tx)

	projectId, err := strconv.ParseInt(graphID, 10, 64)
	if err != nil {
		return err
	}

	err = qtx.DeleteProject(ctx, projectId)
	if err != nil {
		return err
	}

	err = tx.Commit(ctx)
	if err != nil {
		return err
	}

	return nil
}

// DeleteFile removes a file and its text units from the graph, then cleans up
// any orphaned entities and relationships that no longer have source references.
func (s *GraphDBStorage) DeleteFile(ctx context.Context, fileID int64, projectID int64) error {
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	q := db.New(s.conn)
	qtx := q.WithTx(tx)

	// Delete the file (cascades: text_units -> entity_sources/relationship_sources)
	err = qtx.DeleteProjectFile(ctx, fileID)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}

	// Delete orphaned entities (no sources remaining)
	err = qtx.DeleteEntitiesWithoutSources(ctx, projectID)
	if err != nil {
		return err
	}

	// Delete orphaned relationships (no sources remaining)
	err = qtx.DeleteRelationshipsWithoutSources(ctx, projectID)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// RollbackFileData removes graph data (text_units, sources, orphaned entities/relationships)
// for the given file IDs without deleting the project_files records themselves.
// This allows the queue to retry processing the same files.
func (s *GraphDBStorage) RollbackFileData(ctx context.Context, fileIDs []int64, projectID int64) error {
	if len(fileIDs) == 0 {
		return nil
	}

	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	q := db.New(s.conn)
	qtx := q.WithTx(tx)

	err = qtx.DeleteTextUnitsByFileIDs(ctx, fileIDs)
	if err != nil {
		return err
	}

	err = qtx.DeleteEntitiesWithoutSources(ctx, projectID)
	if err != nil {
		return err
	}

	err = qtx.DeleteRelationshipsWithoutSources(ctx, projectID)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}
