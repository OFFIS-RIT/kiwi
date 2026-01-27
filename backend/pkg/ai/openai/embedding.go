package openai

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"

	"github.com/openai/openai-go/v3"
	"golang.org/x/sync/errgroup"
)

const defaultDimensions = 4096

// GenerateEmbedding creates a vector embedding for the given input text
// using the configured embedding model.
//
// The input is provided as a byte slice and will be converted to a string
// before being sent to the embedding model. The returned slice contains
// the embedding vector as float32 values.
//
// Example:
//
//	embedding, err := client.GenerateEmbedding(ctx, []byte("Graph RAG systems"))
//	if err != nil {
//		log.Fatal(err)
//	}
//	fmt.Println("Embedding length:", len(embedding))
func (c *GraphOpenAIClient) GenerateEmbedding(ctx context.Context, input []byte) ([]float32, error) {
	res, err := c.GenerateEmbeddings(ctx, [][]byte{input})
	if err != nil {
		return nil, err
	}
	if len(res) != 1 {
		return nil, fmt.Errorf("unexpected embedding result size: got %d want 1", len(res))
	}
	return res[0], nil
}

// GenerateEmbeddings creates embeddings for multiple inputs in a single request.
// This is an internal fast path used by the storage layer.
func (c *GraphOpenAIClient) GenerateEmbeddings(ctx context.Context, inputs [][]byte) ([][]float32, error) {
	dim := int(util.GetEnvNumeric("AI_EMBED_DIM", defaultDimensions))
	if len(inputs) == 0 {
		return nil, nil
	}

	idxMap, stringsIn, out := normalizeEmbeddingInputs(inputs, dim)
	if len(stringsIn) == 0 {
		return out, nil
	}

	stringsOut, err := c.generateEmbeddingsForStrings(ctx, stringsIn, dim)
	if err != nil {
		return nil, err
	}
	if len(stringsOut) != len(stringsIn) {
		return nil, fmt.Errorf("embedding result size mismatch: got %d want %d", len(stringsOut), len(stringsIn))
	}
	for i := range stringsOut {
		out[idxMap[i]] = stringsOut[i]
	}
	return out, nil
}

// GenerateEmbeddingsChunks generates embeddings for each chunk and returns a single
// flattened result slice, preserving chunk order and input order within each chunk.
//
// Chunk requests are executed concurrently; the client's internal semaphore limits
// actual parallelism.
func (c *GraphOpenAIClient) GenerateEmbeddingsChunks(ctx context.Context, chunks [][][]byte) ([][]float32, error) {
	if len(chunks) == 0 {
		return nil, nil
	}

	outChunks := make([][][]float32, len(chunks))
	eg, ectx := errgroup.WithContext(ctx)
	for i := range chunks {
		idx := i
		chunk := chunks[i]
		eg.Go(func() error {
			res, err := c.GenerateEmbeddings(ectx, chunk)
			if err != nil {
				return err
			}
			outChunks[idx] = res
			return nil
		})
	}
	if err := eg.Wait(); err != nil {
		return nil, err
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

func normalizeEmbeddingInputs(inputs [][]byte, dim int) (idxMap []int, stringsIn []string, out [][]float32) {
	idxMap = make([]int, 0, len(inputs))
	stringsIn = make([]string, 0, len(inputs))
	out = make([][]float32, len(inputs))
	for i, in := range inputs {
		if len(in) == 0 || len(strings.TrimSpace(string(in))) == 0 {
			out[i] = make([]float32, dim)
			continue
		}
		idxMap = append(idxMap, i)
		stringsIn = append(stringsIn, string(in))
	}
	return idxMap, stringsIn, out
}

func (c *GraphOpenAIClient) generateEmbeddingsForStrings(ctx context.Context, inputs []string, dim int) ([][]float32, error) {
	if len(inputs) == 0 {
		return nil, nil
	}

	rCtx, cancel := context.WithTimeout(ctx, time.Minute*time.Duration(c.timeoutMin))
	defer cancel()

	body := openai.EmbeddingNewParams{
		Input: openai.EmbeddingNewParamsInputUnion{OfArrayOfStrings: inputs},
		Model: c.embeddingModel,
	}

	if err := c.embeddingLock.Acquire(rCtx, 1); err != nil {
		return nil, err
	}
	defer c.embeddingLock.Release(1)

	start := time.Now()
	response, err := c.EmbeddingClient.Embeddings.New(rCtx, body)
	if err != nil {
		return nil, err
	}

	duration := time.Since(start).Milliseconds()
	metrics := ai.ModelMetrics{
		InputTokens:  int(response.Usage.PromptTokens),
		OutputTokens: 0,
		TotalTokens:  int(response.Usage.TotalTokens),
		DurationMs:   duration,
	}
	c.modifyMetrics(metrics)

	if len(response.Data) != len(inputs) {
		return nil, fmt.Errorf("embedding response size mismatch: got %d want %d", len(response.Data), len(inputs))
	}

	out := make([][]float32, len(inputs))
	for _, embedding := range response.Data {
		dataIdx := int(embedding.Index)
		if dataIdx < 0 || dataIdx >= len(inputs) {
			return nil, fmt.Errorf("embedding index out of range: %d", embedding.Index)
		}
		vec := make([]float32, 0, dim)
		for _, v := range embedding.Embedding {
			if len(vec) >= dim {
				break
			}
			vec = append(vec, float32(v))
		}
		if len(vec) < dim {
			padded := make([]float32, dim)
			copy(padded, vec)
			vec = padded
		}
		out[dataIdx] = vec
	}
	for i := range out {
		if out[i] == nil {
			return nil, fmt.Errorf("missing embedding for index %d", i)
		}
	}
	return out, nil
}
