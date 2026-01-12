package ollama

import (
	"context"
	"strings"

	"github.com/ollama/ollama/api"
	"kiwi/pkg/ai"
)

const embeddingDimensions = 4096

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
	if len(input) == 0 || len(strings.TrimSpace(string(input))) == 0 {
		return make([]float32, embeddingDimensions), nil
	}

	req := &api.EmbedRequest{
		Model:      c.embeddingModel,
		Input:      string(input),
		Dimensions: embeddingDimensions,
	}

	res, err := c.Client.Embed(ctx, req)
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

	out := make([]float32, 0, embeddingDimensions)
	for _, v := range res.Embeddings {
		for _, val := range v {
			if len(out) >= embeddingDimensions {
				break
			}
			out = append(out, float32(val))
		}
	}
	return out, nil
}
