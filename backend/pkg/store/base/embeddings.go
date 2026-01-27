package base

import (
	"context"
	"fmt"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"golang.org/x/sync/errgroup"
)

type embeddingBatcher interface {
	GenerateEmbeddings(ctx context.Context, inputs [][]byte) ([][]float32, error)
}

func generateEmbeddings(
	ctx context.Context,
	client ai.GraphAIClient,
	inputs [][]byte,
) ([][]float32, error) {
	if client == nil {
		return nil, fmt.Errorf("ai client is nil")
	}
	if len(inputs) == 0 {
		return nil, nil
	}
	if b, ok := client.(embeddingBatcher); ok {
		return b.GenerateEmbeddings(ctx, inputs)
	}

	out := make([][]float32, len(inputs))

	eg, ectx := errgroup.WithContext(ctx)
	for i := range inputs {
		idx := i
		in := inputs[i]
		eg.Go(func() error {
			emb, err := client.GenerateEmbedding(ectx, in)
			if err != nil {
				return err
			}
			out[idx] = emb
			return nil
		})
	}
	if err := eg.Wait(); err != nil {
		return nil, err
	}

	return out, nil
}
