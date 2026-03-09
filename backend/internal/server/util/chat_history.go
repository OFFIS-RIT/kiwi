package util

import (
	"context"
	"regexp"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

var citationIDPattern = regexp.MustCompile(`\[\[([^][]+)\]\]`)

type CitationData struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Key  string `json:"key"`
}

func ExtractCitationIDs(text string) []string {
	matches := citationIDPattern.FindAllStringSubmatch(text, -1)
	ids := make([]string, 0, len(matches))
	seen := make(map[string]struct{}, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}

		id := match[1]
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}

		seen[id] = struct{}{}
		ids = append(ids, id)
	}

	return ids
}

func ResolveCitationData(ctx context.Context, q *pgdb.Queries, projectID string, citationIDs []string) ([]CitationData, error) {
	files, err := q.GetFilesFromTextUnitIDs(ctx, pgdb.GetFilesFromTextUnitIDsParams{
		SourceIds: citationIDs,
		ProjectID: projectID,
	})
	if err != nil {
		return nil, err
	}

	fileData := make([]CitationData, 0, len(files))
	for _, file := range files {
		fileData = append(fileData, CitationData{
			ID:   file.ID,
			Key:  file.FileKey,
			Name: file.Name,
		})
	}

	return fileData, nil
}

func ResolveCitationDataByMessage(ctx context.Context, q *pgdb.Queries, projectID string, messages []pgdb.ChatMessage) (map[string][]CitationData, error) {
	messageCitationIDs := make(map[string][]string)
	allCitationIDs := make([]string, 0)
	allCitationIDSet := make(map[string]struct{})

	for _, message := range messages {
		citationIDs := ExtractCitationIDs(message.Content)
		if len(citationIDs) == 0 {
			continue
		}

		messageCitationIDs[message.ID] = citationIDs
		for _, citationID := range citationIDs {
			if _, exists := allCitationIDSet[citationID]; exists {
				continue
			}
			allCitationIDSet[citationID] = struct{}{}
			allCitationIDs = append(allCitationIDs, citationID)
		}
	}

	if len(allCitationIDs) == 0 {
		return map[string][]CitationData{}, nil
	}

	files, err := ResolveCitationData(ctx, q, projectID, allCitationIDs)
	if err != nil {
		return nil, err
	}

	citationByID := make(map[string]CitationData)
	for _, file := range files {
		citationByID[file.ID] = file
	}

	resolvedByMessageID := make(map[string][]CitationData)
	for messageID, citationIDs := range messageCitationIDs {
		resolved := make([]CitationData, 0, len(citationIDs))
		for _, citationID := range citationIDs {
			citationData, ok := citationByID[citationID]
			if !ok {
				continue
			}
			resolved = append(resolved, citationData)
		}

		if len(resolved) > 0 {
			resolvedByMessageID[messageID] = resolved
		}
	}

	return resolvedByMessageID, nil
}
