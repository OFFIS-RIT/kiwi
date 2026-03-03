package graph

import (
	"context"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/chunking"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
)

type processUnit struct {
	id     string
	fileID string
	start  int
	end    int
	text   string
}

func getUnitsFromText(
	ctx context.Context,
	file loader.GraphFile,
) ([]processUnit, error) {
	textBytes, err := file.GetText(ctx)
	if err != nil {
		return nil, err
	}

	text := strings.TrimSpace(string(textBytes))
	if text == "" {
		return nil, nil
	}

	chunks, err := file.Chunker.Chunk(ctx, text)
	if err != nil {
		return nil, err
	}

	return mapChunksToProcessUnits(chunks, file.ID)
}

func mapChunksToProcessUnits(chunks []chunking.Chunk, fileID string) ([]processUnit, error) {
	units := make([]processUnit, 0, len(chunks))
	for _, chunk := range chunks {
		chunkText := strings.TrimSpace(chunk.Text)
		if chunkText == "" {
			continue
		}

		start := len(units)
		units = append(units, processUnit{
			id:     chunk.ID,
			fileID: fileID,
			start:  start,
			end:    start + 1,
			text:   chunkText,
		})
	}

	return units, nil
}
