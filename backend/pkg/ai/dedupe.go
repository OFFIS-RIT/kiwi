package ai

import (
	"context"
	"fmt"
	"strings"

	gUtil "github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
)

const DedupeBatchSize = 600

// DuplicateGroup represents a group of duplicate entities with a canonical name
type DuplicateGroup struct {
	Name     string   `json:"canonicalName" jsonschema_description:"The final name for the deduplicated entities."`
	Entities []string `json:"entities" jsonschema_description:"List of entity names that are considered duplicates."`
}

// DuplicatesResponse is the response from the AI dedupe call
type DuplicatesResponse struct {
	Duplicates []DuplicateGroup `json:"duplicates" jsonschema_description:"List of groups of duplicate entities."`
}

// CallDedupeAI calls the AI to identify duplicate entities
func CallDedupeAI(
	ctx context.Context,
	entities []common.Entity,
	aiClient GraphAIClient,
	maxRetries int,
) (*DuplicatesResponse, error) {
	var entityData strings.Builder
	entityData.WriteString("Entities:\n")
	for _, e := range entities {
		fmt.Fprintf(&entityData, "- Name: %s, Type: %s\n", e.Name, e.Type)
	}
	prompt := fmt.Sprintf(DedupePrompt, entityData.String())

	var res DuplicatesResponse
	err := gUtil.RetryErrWithContext(ctx, maxRetries, func(ctx context.Context) error {
		return aiClient.GenerateCompletionWithFormat(
			ctx, "dedupe_entities", "Deduplicate similar entities.", prompt, &res,
		)
	})
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// GetDedupeBatchSize returns the batch size for deduplication
func GetDedupeBatchSize() int {
	return DedupeBatchSize
}
