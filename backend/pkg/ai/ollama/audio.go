package ollama

import (
	"context"
)

// GenerateAudioTranscription transcribes audio to text.
// Note: Audio transcription is not currently supported by Ollama; this method returns empty string.
func (c *GraphOllamaClient) GenerateAudioTranscription(
	ctx context.Context,
	audio []byte,
	language string,
) (string, error) {
	return "", nil
}
