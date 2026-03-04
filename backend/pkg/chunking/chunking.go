package chunking

import "context"

type Chunk struct {
	ID   string
	Text string
}

type Chunker interface {
	Chunk(ctx context.Context, input string) ([]Chunk, error)
}
