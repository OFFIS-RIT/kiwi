package ollama

import (
	"context"
	"encoding/base64"

	"kiwi/pkg/ai"
	"kiwi/pkg/loader"

	"github.com/ollama/ollama/api"
)

// GenerateImageDescription sends a vision chat request with a base64 image and
// returns the model's textual description.
func (c *GraphOllamaClient) GenerateImageDescription(
	ctx context.Context,
	prompt string,
	b64 loader.GraphBase64,
) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64.Base64)
	if err != nil {
		return "", err
	}

	stream := false

	req := &api.ChatRequest{
		Model: c.imageModel,
		Messages: []api.Message{
			{Role: "system", Content: prompt},
			{
				Role:    "user",
				Content: "",
				Images:  []api.ImageData{raw},
			},
		},
		Stream: &stream,
	}

	var final api.ChatResponse
	if err := c.Client.Chat(ctx, req, func(cr api.ChatResponse) error {
		final = cr
		return nil
	}); err != nil {
		return "", err
	}

	durationMs := final.TotalDuration.Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  final.Metrics.PromptEvalCount,
		OutputTokens: final.Metrics.EvalCount,
		TotalTokens:  final.Metrics.PromptEvalCount + final.Metrics.EvalCount,
		DurationMs:   durationMs,
	}
	c.modifyMetrics(metrics)

	return final.Message.Content, nil
}
