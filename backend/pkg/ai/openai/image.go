package openai

import (
	"context"
	"fmt"
	"time"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"

	"github.com/openai/openai-go/v3"
)

// GenerateImageDescription sends a vision request with a base64-encoded image
// and returns the model's textual description based on the provided prompt.
func (c *GraphOpenAIClient) GenerateImageDescription(
	ctx context.Context,
	prompt string,
	base64 loader.GraphBase64,
) (string, error) {
	client := c.ImageClient

	url := fmt.Sprintf("%s%s", base64.FileType, base64.Base64)
	body := openai.ChatCompletionNewParams{
		Model: openai.ChatModel(c.imageModel),
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(prompt),
			openai.UserMessage([]openai.ChatCompletionContentPartUnionParam{
				openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{
					URL: url,
				}),
			}),
		},
	}

	err := c.imageLock.Acquire(ctx, 1)
	if err != nil {
		return "", err
	}
	defer c.imageLock.Release(1)

	start := time.Now()
	response, err := client.Chat.Completions.New(ctx, body)
	if err != nil {
		return "", err
	}
	duration := time.Since(start).Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  int(response.Usage.PromptTokens),
		OutputTokens: int(response.Usage.CompletionTokens),
		TotalTokens:  int(response.Usage.TotalTokens),
		DurationMs:   duration,
	}
	c.modifyMetrics(metrics)

	return response.Choices[0].Message.Content, nil
}
