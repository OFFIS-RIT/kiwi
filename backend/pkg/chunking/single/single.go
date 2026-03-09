package single

import (
	"context"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/chunking"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
)

type SingleChunker struct{}

func NewSingleChunker() *SingleChunker {
	return &SingleChunker{}
}

func (c *SingleChunker) Chunk(_ context.Context, input string) ([]chunking.Chunk, error) {
	return []chunking.Chunk{
		{
			ID:   ids.New(),
			Text: input,
		},
	}, nil
}
