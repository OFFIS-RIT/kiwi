package base

import (
	"context"
	"github.com/OFFIS-RIT/kiwi/backend/internal/db"
	"strconv"

	"github.com/jackc/pgx/v5"
)

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
