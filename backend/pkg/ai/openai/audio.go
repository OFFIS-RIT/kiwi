package openai

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"kiwi/pkg/ai"

	"github.com/openai/openai-go/v3"
)

// GenerateAudioTranscription transcribes audio data to text using the configured audio model.
// The language parameter is optional and can be used to hint the expected language.
func (c *GraphOpenAIClient) GenerateAudioTranscription(
	ctx context.Context,
	audio []byte,
	language string,
) (string, error) {
	client := c.AudioClient
	if client == nil {
		return "", fmt.Errorf("audio client not configured")
	}

	params := openai.AudioTranscriptionNewParams{
		File:  bytes.NewReader(audio),
		Model: openai.AudioModel(c.audioModel),
	}

	if language != "" {
		params.Language = openai.String(language)
	}

	start := time.Now()
	transcription, err := client.Audio.Transcriptions.New(ctx, params)
	if err != nil {
		return "", err
	}
	duration := time.Since(start).Milliseconds()

	metrics := ai.ModelMetrics{
		InputTokens:  0, // OpenAI doesn't return token usage for audio
		OutputTokens: 0,
		TotalTokens:  0,
		DurationMs:   duration,
	}
	c.modifyMetrics(metrics)

	return transcription.Text, nil
}
