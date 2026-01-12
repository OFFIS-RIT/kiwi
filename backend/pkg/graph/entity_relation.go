package graph

import (
	"context"
	"fmt"
	"strings"

	"kiwi/pkg/ai"
	"kiwi/pkg/common"
)

func generateDescription(
	ctx context.Context,
	desc string,
	name string,
	client ai.GraphAIClient,
) (string, error) {
	prompt := fmt.Sprintf(ai.DescPrompt, name, desc)

	res, err := client.GenerateCompletion(ctx, prompt)
	if err != nil {
		return "", err
	}

	res = strings.ReplaceAll(res, "\r\n", " ")
	res = strings.ReplaceAll(res, "\n", " ")
	res = strings.ReplaceAll(res, "\r", " ")
	res = strings.TrimSpace(res)
	res = strings.Join(strings.Fields(res), " ")

	return res, nil

}

func generateEntityDescription(
	ctx context.Context,
	entity *common.Entity,
	client ai.GraphAIClient,
) error {
	desc := ""
	for idx, source := range entity.Sources {
		desc += source.Description
		if idx < len(entity.Sources)-1 {
			desc += "\n\n"
		}
	}

	d, err := generateDescription(ctx, desc, entity.Name, client)
	if err != nil {
		return err
	}

	(*entity).Description = d
	return nil
}

func generateRelationshipDescription(
	ctx context.Context,
	relation *common.Relationship,
	client ai.GraphAIClient,
) error {
	desc := ""
	for idx, source := range relation.Sources {
		desc += source.Description
		if idx < len(relation.Sources)-1 {
			desc += "\n\n"
		}
	}

	d, err := generateDescription(
		ctx,
		desc,
		fmt.Sprintf("%s -> %s", relation.Source.Name, relation.Target.Name),
		client,
	)
	if err != nil {
		return err
	}

	(*relation).Description = d
	return nil
}
