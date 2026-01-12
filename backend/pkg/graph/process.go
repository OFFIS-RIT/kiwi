package graph

import (
	"context"
	"fmt"
	"strings"
	"sync"

	gUtil "kiwi/internal/util"
	"kiwi/pkg/ai"
	"kiwi/pkg/common"
	"kiwi/pkg/loader"

	"golang.org/x/sync/errgroup"
)

type processFileResult struct {
	entities  []common.Entity
	relations []common.Relationship
	units     []*common.Unit
}

func processFile(
	ctx context.Context,
	file loader.GraphFile,
	encoder string,
	client ai.GraphAIClient,
	parallelMax int,
	maxRetries int,
) (*processFileResult, error) {
	units, err := getUnitsFromText(ctx, file, encoder)
	if err != nil {
		return nil, fmt.Errorf("Failed to extract units from input text:\n%w", err)
	}

	filenamesplit := strings.Split(file.FilePath, "/")
	filename := filenamesplit[len(filenamesplit)-1]

	entities := make([]common.Entity, 0)
	relations := make([]common.Relationship, 0)
	finaleUnits := make([]*common.Unit, 0, len(units))
	mergeMu := sync.Mutex{}

	g, gCtx := errgroup.WithContext(ctx)
	g.SetLimit(parallelMax)
	for _, unit := range units {
		u := unit
		g.Go(func() error {
			select {
			case <-gCtx.Done():
				return nil
			default:
				fu, e, r, err := gUtil.Retry3WithContext(gCtx, maxRetries, func(ctx context.Context) (*common.Unit, []common.Entity, []common.Relationship, error) {
					return extractFromUnit(gCtx, u, filename, file.CustomEntities, client)
				})
				if err != nil {
					return fmt.Errorf("Failed to extract entities and relationships from text:\n%w", err)
				}

				mergeMu.Lock()
				finaleUnits = append(finaleUnits, fu)
				entities, relations = mergeEntitiesAndRelations(entities, e, relations, r)
				mergeMu.Unlock()
				return nil
			}
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}

	res := &processFileResult{
		entities:  entities,
		relations: relations,
		units:     finaleUnits,
	}
	return res, nil
}
