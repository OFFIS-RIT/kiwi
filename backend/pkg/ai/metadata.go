package ai

import (
	"context"
	"fmt"
)

// ExtractDocumentMetadata analyzes document content and extracts metadata
// using the AI description model.
func ExtractDocumentMetadata(
	ctx context.Context,
	aiClient GraphAIClient,
	fileName string,
	content string,
) (string, error) {
	sections := ExtractDocumentSections(content)

	cleanContent := StripMetadataTags(content)

	contentExcerpt := ExtractFirstNWords(cleanContent, 500)

	prompt := fmt.Sprintf(MetadataPrompt,
		fileName,
		formatSection(sections.Header),
		formatSection(sections.Footer),
		formatSection(sections.Signature),
		contentExcerpt,
	)

	metadata, err := aiClient.GenerateCompletion(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("metadata extraction failed: %w", err)
	}

	return metadata, nil
}

// formatSection returns the section content or "Not present" if empty
func formatSection(section string) string {
	if section == "" {
		return "Not present"
	}
	return section
}
