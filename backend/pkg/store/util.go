package store

import (
	"context"
	"fmt"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"golang.org/x/sync/errgroup"
)

func ChunkRange(total, chunkSize int, fn func(start, end int) error) error {
	if total <= 0 {
		return nil
	}
	if chunkSize <= 0 {
		chunkSize = total
	}
	for start := 0; start < total; start += chunkSize {
		end := min(start+chunkSize, total)
		if err := fn(start, end); err != nil {
			return err
		}
	}
	return nil
}

func DedupeStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

type embeddingBatcher interface {
	GenerateEmbeddings(ctx context.Context, inputs [][]byte) ([][]float32, error)
}

func GenerateEmbeddings(
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
