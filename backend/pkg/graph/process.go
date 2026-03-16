package graph

import (
	"context"
	"fmt"
	"sync"

	gUtil "github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"

	"golang.org/x/sync/errgroup"
)

type processFileResult struct {
	entities  []common.Entity
	relations []common.Relationship
	units     []*common.Unit
}

type ExtractFile struct {
	ID             string
	FilePath       string
	FileType       loader.GraphFileType
	CustomEntities []string
	Description    string
	Metadata       string
}

func ExtractFromUnits(
	ctx context.Context,
	file ExtractFile,
	units []*common.Unit,
	client ai.GraphAIClient,
	maxRetries int,
) ([]common.Entity, []common.Relationship, error) {
	entities := make([]common.Entity, 0)
	relations := make([]common.Relationship, 0)
	mergeMu := sync.Mutex{}
	loaderFile := loader.GraphFile{
		ID:             file.ID,
		FilePath:       file.FilePath,
		FileType:       file.FileType,
		CustomEntities: file.CustomEntities,
		Description:    file.Description,
		Metadata:       file.Metadata,
	}

	g, gCtx := errgroup.WithContext(ctx)
	for _, unit := range units {
		u := unit
		g.Go(func() error {
			select {
			case <-gCtx.Done():
				return nil
			default:
				_, e, r, err := gUtil.Retry3WithContext(gCtx, maxRetries, func(ctx context.Context) (*common.Unit, []common.Entity, []common.Relationship, error) {
					return extractFromCommonUnit(ctx, u, loaderFile, client)
				})
				if err != nil {
					return fmt.Errorf("Failed to extract entities and relationships from text:\n%w", err)
				}

				mergeMu.Lock()
				entities, relations = mergeEntitiesAndRelations(entities, e, relations, r)
				mergeMu.Unlock()
				return nil
			}
		})
	}

	if err := g.Wait(); err != nil {
		return nil, nil, err
	}

	return entities, relations, nil
}

func processFile(
	ctx context.Context,
	file loader.GraphFile,
	client ai.GraphAIClient,
	maxRetries int,
) (*processFileResult, error) {
	units, err := getUnitsFromText(ctx, file)
	if err != nil {
		return nil, fmt.Errorf("Failed to extract units from input text:\n%w", err)
	}

	entities := make([]common.Entity, 0)
	relations := make([]common.Relationship, 0)
	extractFile := ExtractFile{
		ID:             file.ID,
		FilePath:       file.FilePath,
		FileType:       file.FileType,
		CustomEntities: file.CustomEntities,
		Description:    file.Description,
		Metadata:       file.Metadata,
	}
	entities, relations, err = ExtractFromUnits(ctx, extractFile, unitsToCommonUnits(units), client, maxRetries)
	if err != nil {
		return nil, err
	}

	res := &processFileResult{
		entities:  entities,
		relations: relations,
		units:     unitsToCommonUnits(units),
	}
	return res, nil
}

func unitsToCommonUnits(units []processUnit) []*common.Unit {
	result := make([]*common.Unit, 0, len(units))
	for _, unit := range units {
		result = append(result, &common.Unit{
			ID:     unit.id,
			FileID: unit.fileID,
			Start:  unit.start,
			End:    unit.end,
			Text:   unit.text,
		})
	}
	return result
}
