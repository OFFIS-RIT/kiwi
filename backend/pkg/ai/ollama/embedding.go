package ollama

import (
	"context"
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
