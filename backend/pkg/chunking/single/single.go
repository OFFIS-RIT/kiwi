package single

import (
	"context"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/chunking"
	gonanoid "github.com/matoous/go-nanoid/v2"
)

type SingleChunker struct{}

func NewSingleChunker() *SingleChunker {
	return &SingleChunker{}
}

func (c *SingleChunker) Chunk(_ context.Context, input string) ([]chunking.Chunk, error) {
	id, err := gonanoid.New()
	if err != nil {
		return nil, err
	}

	return []chunking.Chunk{
		{
			ID:   id,
			Text: input,
		},
	}, nil
}
