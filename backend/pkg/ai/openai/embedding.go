package openai

import (
	"context"
	"strings"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/packages/param"
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
	dim := int(util.GetEnvNumeric("AI_EMBED_DIM", defaultDimensions))
	if len(input) == 0 || len(strings.TrimSpace(string(input))) == 0 {
		return make([]float32, dim), nil
	}

	client := c.EmbeddingClient

	body := openai.EmbeddingNewParams{
		Input: openai.EmbeddingNewParamsInputUnion{
			OfString: param.NewOpt(string(input)),
		},
		Model: c.embeddingModel,
	}

	err := c.embeddingLock.Acquire(ctx, 1)
	if err != nil {
		return nil, err
	}
	defer c.embeddingLock.Release(1)

	start := time.Now()
	response, err := client.Embeddings.New(ctx, body)
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

	result := make([]float32, 0, dim)
	for _, embedding := range response.Data {
		for _, embed := range embedding.Embedding {
			if len(result) >= dim {
				break
			}
			result = append(result, float32(embed))
		}
	}

	return result, nil
}
