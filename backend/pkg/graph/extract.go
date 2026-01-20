package graph

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	_ "github.com/invopop/jsonschema"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"

	gonanoid "github.com/matoous/go-nanoid/v2"
)

type extractEntity struct {
	EntityName        string `json:"entity_name" jsonschema_description:"Name of the entity, all letters capitalized"`
	EntityType        string `json:"entity_type" jsonschema_description:"One of the provided entity types"`
	EntityDescription string `json:"entity_description" jsonschema_description:"Comprehensive description of the entity's attributes, activities and information provided by the source."`
}

type extractRelationship struct {
	SourceEntity            string  `json:"source_entity" jsonschema_description:"Name of the source entity, as identified in step 1"`
	TargetEntity            string  `json:"target_entity" jsonschema_description:"Name of the target entity, as identified in step 1"`
	RelationshipDescription string  `json:"relationship_description" jsonschema_description:"Explanation as to why you think the source entity and the target entity are related to each other"`
	RelationshipStrength    float64 `json:"relationship_strength" jsonschema_description:"A numeric score indicating strength of the relationship between the source entity and target entity"`
}

type extractResponse struct {
	Entities      []extractEntity       `json:"entities" jsonschema_description:"Entities identified in the text document"`
	Relationships []extractRelationship `json:"relationships" jsonschema_description:"Relationships identified in the text document"`
}

func extractFromUnit(
	ctx context.Context,
	unit processUnit,
	file loader.GraphFile,
	client ai.GraphAIClient,
) (*common.Unit, []common.Entity, []common.Relationship, error) {
	e := file.CustomEntities
	if len(e) == 0 {
		e = []string{"ORGANIZATION", "PERSON", "LOCATION", "CONCEPT", "CREATIVE_WORK", "DATE", "PRODUCT", "EVENT"}
	}

	promptTemplate := ai.ExtractPromptText
	if file.FileType == loader.GraphFileTypeCSV {
		promptTemplate = ai.ExtractPromptCSV
	}
	if file.FileType == loader.GraphFileTypeImage {
		promptTemplate = ai.ExtractPromptChart
	}

	baseName := filepath.Base(file.FilePath)
	var systemPrompt string
	if file.FileType == loader.GraphFileTypeCSV {
		csvSummary := summarizeCSV(unit.text, baseName)
		systemPrompt = fmt.Sprintf(
			promptTemplate,
			strings.Join(e, ","),
			baseName,
			csvSummary,
			strings.Join(e, ","),
			strings.Join(e, ","),
		)
	} else {
		systemPrompt = fmt.Sprintf(
			promptTemplate,
			strings.Join(e, ","),
			baseName,
			strings.Join(e, ","),
			strings.Join(e, ","),
		)
	}

	if strings.TrimSpace(file.Metadata) != "" {
		systemPrompt = fmt.Sprintf("%s\n\nDocument metadata:\n%s", systemPrompt, strings.TrimSpace(file.Metadata))
	}

	var res extractResponse
	opts := []ai.GenerateOption{
		ai.WithSystemPrompts(systemPrompt),
	}
	err := client.GenerateCompletionWithFormat(
		ctx,
		"extract_entities_and_relationships",
		"Extract entities and relationships form a provided document.",
		unit.text,
		&res,
		opts...,
	)
	if err != nil {
		return nil, nil, nil, err
	}

	finalUnit := &common.Unit{
		ID:     unit.id,
		FileID: unit.fileID,
		Start:  unit.start,
		End:    unit.end,
		Text:   unit.text,
	}

	entities := make([]common.Entity, 0, len(res.Entities))
	relations := make([]common.Relationship, 0, len(res.Relationships))
	for _, entity := range res.Entities {
		eId, err := gonanoid.New()
		if err != nil {
			return nil, nil, nil, fmt.Errorf("failed to generate ID for entity: %w", err)
		}
		sId, err := gonanoid.New()
		if err != nil {
			return nil, nil, nil, fmt.Errorf("failed to generate ID for source: %w", err)
		}
		s := common.Source{
			ID:          sId,
			Unit:        finalUnit,
			Description: entity.EntityDescription,
		}
		e := common.Entity{
			ID:      eId,
			Name:    entity.EntityName,
			Type:    entity.EntityType,
			Sources: []common.Source{s},
		}
		entities = append(entities, e)
	}
	for _, rel := range res.Relationships {
		rId, err := gonanoid.New()
		if err != nil {
			return nil, nil, nil, fmt.Errorf("failed to generate ID for entity: %w", err)
		}
		sId, err := gonanoid.New()
		if err != nil {
			return nil, nil, nil, fmt.Errorf("failed to generate ID for source: %w", err)
		}
		s := common.Source{
			ID:          sId,
			Unit:        finalUnit,
			Description: rel.RelationshipDescription,
		}
		var sr, tr *common.Entity
		for i := range entities {
			if entities[i].Name == rel.SourceEntity {
				sr = &entities[i]
				continue
			}
			if entities[i].Name == rel.TargetEntity {
				tr = &entities[i]
				continue
			}
		}
		if sr == nil || tr == nil {
			continue
		}
		r := common.Relationship{
			ID:       rId,
			Source:   sr,
			Target:   tr,
			Strength: rel.RelationshipStrength,
			Sources:  []common.Source{s},
		}

		relations = append(relations, r)
	}

	return finalUnit, entities, relations, nil
}

func summarizeCSV(text string, baseName string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}

	rows := strings.Split(trimmed, "\n")
	if len(rows) == 0 {
		return ""
	}

	header := rows[0]
	dataRows := rows
	if isCSVHeader(rows) {
		dataRows = rows[1:]
	}

	sampleCount := util.Min(3, len(dataRows))
	var sampleRows []string
	for i := range sampleCount {
		sampleRows = append(sampleRows, dataRows[i])
	}

	var summary strings.Builder
	if baseName != "" {
		summary.WriteString("Filename: ")
		summary.WriteString(baseName)
		summary.WriteString("\n")
	}
	if header != "" {
		summary.WriteString("Headers: ")
		summary.WriteString(header)
		summary.WriteString("\n")
	}
	fmt.Fprintf(&summary, "Row count: %d\n", len(dataRows))
	if len(sampleRows) > 0 {
		summary.WriteString("Sample rows:\n")
		summary.WriteString(strings.Join(sampleRows, "\n"))
	}

	return summary.String()
}
