package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	graphstorage "github.com/OFFIS-RIT/kiwi/backend/pkg/store/pgx"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rabbitmq/amqp091-go"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
)

func KickoffDescriptionJobsForCorrelation(
	ctx context.Context,
	ch *amqp091.Channel,
	pool *pgxpool.Pool,
	correlationID string,
	projectID int64,
) (int, error) {
	q := pgdb.New(pool)

	jobs, err := q.GetDescriptionJobsByCorrelation(ctx, correlationID)
	if err != nil {
		return 0, err
	}

	if len(jobs) == 0 {
		batches, err := q.GetBatchesByCorrelation(ctx, correlationID)
		if err != nil {
			return 0, fmt.Errorf("failed to get batches: %w", err)
		}

		fileIDSet := make(map[int64]struct{})
		for _, batch := range batches {
			for _, fid := range batch.FileIds {
				fileIDSet[fid] = struct{}{}
			}
		}

		if len(fileIDSet) == 0 {
			return 0, nil
		}

		fileIDs := make([]int64, 0, len(fileIDSet))
		for fid := range fileIDSet {
			fileIDs = append(fileIDs, fid)
		}
		slices.Sort(fileIDs)

		entities, err := q.GetEntitiesWithSourcesFromFiles(ctx, pgdb.GetEntitiesWithSourcesFromFilesParams{
			Column1:   fileIDs,
			ProjectID: projectID,
		})
		if err != nil {
			return 0, fmt.Errorf("failed to get entities: %w", err)
		}
		rels, err := q.GetRelationshipsWithSourcesFromFiles(ctx, pgdb.GetRelationshipsWithSourcesFromFilesParams{
			Column1:   fileIDs,
			ProjectID: projectID,
		})
		if err != nil {
			return 0, fmt.Errorf("failed to get relationships: %w", err)
		}

		type item struct {
			kind string
			id   int64
		}
		items := make([]item, 0, len(entities)+len(rels))
		for _, e := range entities {
			items = append(items, item{kind: "entity", id: e.ID})
		}
		for _, r := range rels {
			items = append(items, item{kind: "relationship", id: r.ID})
		}
		sort.Slice(items, func(i, j int) bool {
			if items[i].kind == items[j].kind {
				return items[i].id < items[j].id
			}
			return items[i].kind < items[j].kind
		})

		jobSize := int(util.GetEnvNumeric("AI_PARALLEL_REQ", 10))
		totalJobs := (len(items) + jobSize - 1) / jobSize
		if totalJobs == 0 {
			return 0, nil
		}

		for i := range totalJobs {
			start := i * jobSize
			end := min(start+jobSize, len(items))
			chunk := items[start:end]

			entityIDs := make([]int64, 0, len(chunk))
			relIDs := make([]int64, 0, len(chunk))
			for _, it := range chunk {
				switch it.kind {
				case "entity":
					entityIDs = append(entityIDs, it.id)
				case "relationship":
					relIDs = append(relIDs, it.id)
				}
			}

			_, err := q.CreateDescriptionJobStatus(ctx, pgdb.CreateDescriptionJobStatusParams{
				ProjectID:       projectID,
				CorrelationID:   correlationID,
				JobID:           int32(i + 1),
				TotalJobs:       int32(totalJobs),
				EntityIds:       entityIDs,
				RelationshipIds: relIDs,
			})
			if err != nil {
				return 0, fmt.Errorf("failed to create description job status: %w", err)
			}
		}

		jobs, err = q.GetDescriptionJobsByCorrelation(ctx, correlationID)
		if err != nil {
			return 0, err
		}
	}

	for _, job := range jobs {
		if job.Status != "pending" && job.Status != "failed" {
			continue
		}
		msg := QueueDescriptionJobMsg{
			ProjectID:       job.ProjectID,
			CorrelationID:   job.CorrelationID,
			JobID:           int(job.JobID),
			TotalJobs:       int(job.TotalJobs),
			EntityIDs:       job.EntityIds,
			RelationshipIDs: job.RelationshipIds,
		}
		b, err := json.Marshal(msg)
		if err != nil {
			return len(jobs), err
		}
		if err := PublishFIFO(ch, "description_queue", b); err != nil {
			return len(jobs), err
		}
	}

	return len(jobs), nil
}

func ProcessDescriptionMessage(
	ctx context.Context,
	aiClient ai.GraphAIClient,
	ch *amqp091.Channel,
	pool *pgxpool.Pool,
	msg string,
) error {
	_ = ch
	data := new(QueueDescriptionJobMsg)
	if err := json.Unmarshal([]byte(msg), data); err != nil {
		return err
	}
	if data.CorrelationID == "" {
		return fmt.Errorf("missing correlation_id")
	}
	if data.JobID <= 0 {
		return fmt.Errorf("invalid job_id")
	}

	q := pgdb.New(pool)
	latestCorrelationID, latestErr := q.GetLatestCorrelationForProject(ctx, data.ProjectID)
	if latestErr == nil && latestCorrelationID != "" && latestCorrelationID != data.CorrelationID {
		_ = q.UpdateDescriptionJobStatus(ctx, pgdb.UpdateDescriptionJobStatusParams{
			CorrelationID: data.CorrelationID,
			JobID:         int32(data.JobID),
			Column3:       "completed",
			ErrorMessage:  pgtype.Text{String: "skipped: superseded correlation", Valid: true},
		})
		return nil
	}

	_, err := q.TryStartDescriptionJob(ctx, pgdb.TryStartDescriptionJobParams{
		CorrelationID: data.CorrelationID,
		JobID:         int32(data.JobID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}

	storageClient, err := graphstorage.NewGraphDBStorageWithConnection(ctx, pool, aiClient, []string{})
	if err != nil {
		_ = q.UpdateDescriptionJobStatus(ctx, pgdb.UpdateDescriptionJobStatusParams{
			CorrelationID: data.CorrelationID,
			JobID:         int32(data.JobID),
			Column3:       "failed",
			ErrorMessage:  pgtype.Text{String: err.Error(), Valid: true},
		})
		return err
	}

	batches, err := q.GetBatchesByCorrelation(ctx, data.CorrelationID)
	if err != nil {
		return err
	}
	fileIDSet := make(map[int64]struct{})
	for _, b := range batches {
		for _, fid := range b.FileIds {
			fileIDSet[fid] = struct{}{}
		}
	}
	fileIDs := make([]int64, 0, len(fileIDSet))
	for fid := range fileIDSet {
		fileIDs = append(fileIDs, fid)
	}
	slices.Sort(fileIDs)

	if err := storageClient.UpdateEntityDescriptionsByIDsFromFiles(ctx, data.EntityIDs, fileIDs); err != nil {
		_ = q.UpdateDescriptionJobStatus(ctx, pgdb.UpdateDescriptionJobStatusParams{
			CorrelationID: data.CorrelationID,
			JobID:         int32(data.JobID),
			Column3:       "failed",
			ErrorMessage:  pgtype.Text{String: err.Error(), Valid: true},
		})
		return err
	}
	if err := storageClient.UpdateRelationshipDescriptionsByIDsFromFiles(ctx, data.RelationshipIDs, fileIDs); err != nil {
		_ = q.UpdateDescriptionJobStatus(ctx, pgdb.UpdateDescriptionJobStatusParams{
			CorrelationID: data.CorrelationID,
			JobID:         int32(data.JobID),
			Column3:       "failed",
			ErrorMessage:  pgtype.Text{String: err.Error(), Valid: true},
		})
		return err
	}

	_ = q.UpdateDescriptionJobStatus(ctx, pgdb.UpdateDescriptionJobStatusParams{
		CorrelationID: data.CorrelationID,
		JobID:         int32(data.JobID),
		Column3:       "completed",
	})

	allDone, err := q.AreAllDescriptionJobsCompleted(ctx, data.CorrelationID)
	if err != nil {
		return err
	}
	if !allDone {
		return nil
	}

	batchesDone, err := q.AreAllBatchesCompleted(ctx, data.CorrelationID)
	if err != nil {
		return err
	}
	if !batchesDone {
		return nil
	}

	latestCorrelationID, latestErr = q.GetLatestCorrelationForProject(ctx, data.ProjectID)
	if latestErr != nil {
		return nil
	}
	if latestCorrelationID != data.CorrelationID {
		return nil
	}

	if _, err := q.UpdateProjectState(ctx, pgdb.UpdateProjectStateParams{ID: data.ProjectID, State: "ready"}); err != nil {
		logger.Error("[Queue] Failed to set project state to ready", "project_id", data.ProjectID, "correlation_id", data.CorrelationID, "err", err)
	}

	return nil
}
