package ollama

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"

	"github.com/ollama/ollama/api"
)

const defaultDimensions = 4096

// GenerateEmbedding creates a vector embedding for the given input text
// using the configured embedding model on Ollama.
//
// The input is provided as a byte slice and converted to a string before
// being sent to the embedding model. The returned slice contains the
// embedding vector as float32 values.
func (c *GraphOllamaClient) GenerateEmbedding(
	ctx context.Context,
	input []byte,
) ([]float32, error) {
	dim := int(util.GetEnvNumeric("AI_EMBED_DIM", defaultDimensions))
	if len(input) == 0 || len(strings.TrimSpace(string(input))) == 0 {
		return make([]float32, dim), nil
	}

	rCtx, cancel := context.WithTimeout(ctx, time.Minute*time.Duration(c.timeoutMin))
	defer cancel()

	req := &api.EmbedRequest{
		Model: c.embeddingModel,
		Input: string(input),
	}

	err := c.reqLock.Acquire(rCtx, 1)
	if err != nil {
		return nil, err
	}
	defer c.reqLock.Release(1)

	res, err := c.Client.Embed(rCtx, req)
	if err != nil {
		return nil, err
	}

	durationMs := res.TotalDuration.Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  res.PromptEvalCount,
		OutputTokens: 0,
		TotalTokens:  res.PromptEvalCount,
		DurationMs:   durationMs,
	}
	c.modifyMetrics(metrics)

	out := make([]float32, 0, dim)
	for _, v := range res.Embeddings {
		for _, val := range v {
			if len(out) >= dim {
				break
			}
			out = append(out, float32(val))
		}
	}
	return out, nil
}

// GenerateEmbeddings creates embeddings for multiple inputs.
//
// Requests are issued concurrently; the client's internal semaphore (reqLock)
// limits actual parallelism.
func (c *GraphOllamaClient) GenerateEmbeddings(ctx context.Context, inputs [][]byte) ([][]float32, error) {
	dim := int(util.GetEnvNumeric("AI_EMBED_DIM", defaultDimensions))
	if len(inputs) == 0 {
		return nil, nil
	}

	out := make([][]float32, len(inputs))

	type result struct {
		idx int
		vec []float32
		err error
	}

	resCh := make(chan result, len(inputs))

	for i := range inputs {
		idx := i
		in := inputs[i]
		go func() {
			if len(in) == 0 || len(strings.TrimSpace(string(in))) == 0 {
				resCh <- result{idx: idx, vec: make([]float32, dim)}
				return
			}
			vec, err := c.GenerateEmbedding(ctx, in)
			resCh <- result{idx: idx, vec: vec, err: err}
		}()
	}

	for range inputs {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case r := <-resCh:
			if r.err != nil {
				return nil, r.err
			}
			if r.vec == nil {
				return nil, fmt.Errorf("nil embedding for index %d", r.idx)
			}
			out[r.idx] = r.vec
		}
	}

	return out, nil
}

// GenerateEmbeddingsChunks generates embeddings for each chunk and returns a
// flattened result slice, preserving chunk order and input order within each chunk.
func (c *GraphOllamaClient) GenerateEmbeddingsChunks(ctx context.Context, chunks [][][]byte) ([][]float32, error) {
	if len(chunks) == 0 {
		return nil, nil
	}

	outChunks := make([][][]float32, len(chunks))

	type chunkRes struct {
		idx int
		out [][]float32
		err error
	}

	ch := make(chan chunkRes, len(chunks))
	for i := range chunks {
		idx := i
		chunk := chunks[i]
		go func() {
			res, err := c.GenerateEmbeddings(ctx, chunk)
			ch <- chunkRes{idx: idx, out: res, err: err}
		}()
	}

	for range chunks {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case r := <-ch:
			if r.err != nil {
				return nil, r.err
			}
			outChunks[r.idx] = r.out
		}
	}

	total := 0
	for _, c := range outChunks {
		total += len(c)
	}
	out := make([][]float32, 0, total)
	for _, c := range outChunks {
		out = append(out, c...)
	}
	return out, nil
}
