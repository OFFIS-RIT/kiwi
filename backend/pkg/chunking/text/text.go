package text

import (
	"context"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/chunking"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	"github.com/pkoukk/tiktoken-go"
)

type TextChunker struct {
	maxChunkSize int
	encoder      string
}

type NewTextChunkerParams struct {
	MaxChunkSize int
	Encoder      string
}

func NewTextChunker(params NewTextChunkerParams) *TextChunker {
	return &TextChunker{
		maxChunkSize: params.MaxChunkSize,
		encoder:      params.Encoder,
	}
}

func (c *TextChunker) Chunk(_ context.Context, input string) ([]chunking.Chunk, error) {
	text := strings.TrimSpace(input)
	if text == "" {
		return nil, nil
	}

	enc, err := tiktoken.GetEncoding(c.encoder)
	if err != nil {
		return nil, err
	}

	counter := newTokenCounter(enc)
	chunkTexts := chunkTextRecursively(text, counter, c.maxChunkSize, semanticSplitDoubleEmpty)
	chunkTexts = mergeTinyChunks(chunkTexts, counter, c.maxChunkSize)

	chunks := make([]string, 0, len(chunkTexts))
	for _, chunkText := range chunkTexts {
		chunkText = strings.TrimSpace(chunkText)
		if chunkText == "" {
			continue
		}
		chunks = append(chunks, chunkText)
	}

	result := make([]chunking.Chunk, len(chunks))
	for i, chunk := range chunks {
		result[i] = chunking.Chunk{
			ID:   ids.New(),
			Text: chunk,
		}
	}

	return result, nil
}
