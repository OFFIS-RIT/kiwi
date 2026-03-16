package graph

import (
	"context"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/chunking"
	csvchunking "github.com/OFFIS-RIT/kiwi/backend/pkg/chunking/csv"
	jsonchunking "github.com/OFFIS-RIT/kiwi/backend/pkg/chunking/json"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/chunking/single"
	textchunking "github.com/OFFIS-RIT/kiwi/backend/pkg/chunking/text"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/common"
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

	resolvedChunker := file.Chunker
	if resolvedChunker == nil {
		resolvedChunker = chunkerForFileType(file.FileType, "o200k_base", 1000)
	}

	chunks, err := resolvedChunker.Chunk(ctx, text)
	if err != nil {
		return nil, err
	}

	return mapChunksToProcessUnits(chunks, file.ID)
}

func ChunkText(ctx context.Context, fileType loader.GraphFileType, text string, tokenEncoder string, maxChunkSize int) ([]chunking.Chunk, error) {
	resolvedChunker := chunkerForFileType(fileType, tokenEncoder, maxChunkSize)
	return resolvedChunker.Chunk(ctx, text)
}

func ExtractUnits(chunks []chunking.Chunk, fileID string) ([]*common.Unit, error) {
	units := make([]*common.Unit, 0, len(chunks))
	for idx, chunk := range chunks {
		chunkText := strings.TrimSpace(chunk.Text)
		if chunkText == "" {
			continue
		}

		units = append(units, &common.Unit{
			ID:     chunk.ID,
			FileID: fileID,
			Start:  idx,
			End:    idx + 1,
			Text:   chunkText,
		})
	}
	return units, nil
}

func mapChunksToProcessUnits(chunks []chunking.Chunk, fileID string) ([]processUnit, error) {
	commonUnits, err := ExtractUnits(chunks, fileID)
	if err != nil {
		return nil, err
	}

	units := make([]processUnit, 0, len(commonUnits))
	for _, unit := range commonUnits {
		units = append(units, processUnit{
			id:     unit.ID,
			fileID: unit.FileID,
			start:  unit.Start,
			end:    unit.End,
			text:   unit.Text,
		})
	}

	return units, nil
}

func chunkerForFileType(fileType loader.GraphFileType, tokenEncoder string, maxChunkSize int) chunking.Chunker {
	if tokenEncoder == "" {
		tokenEncoder = "o200k_base"
	}
	if maxChunkSize <= 0 {
		maxChunkSize = 1000
	}

	switch fileType {
	case loader.GraphFileTypeCSV:
		return csvchunking.NewCSVChunker(csvchunking.NewCSVChunkerParams{
			MaxChunkSize: maxChunkSize,
			Encoder:      tokenEncoder,
		})
	case loader.GraphFileTypeJSON:
		return jsonchunking.NewJSONChunker(jsonchunking.NewJSONChunkerParams{
			MaxChunkSize: maxChunkSize,
			Encoder:      tokenEncoder,
		})
	case loader.GraphFileTypeFile:
		return single.NewSingleChunker()
	default:
		return textchunking.NewTextChunker(textchunking.NewTextChunkerParams{
			MaxChunkSize: maxChunkSize,
			Encoder:      tokenEncoder,
		})
	}
}
