package audio

import (
	"context"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
)

// AudioGraphLoader loads audio files and transcribes them to text using an AI client.
type AudioGraphLoader struct {
	aiClient ai.GraphAIClient
	loader   loader.GraphFileLoader
}

// NewAudioGraphLoaderParams contains configuration for creating an AudioGraphLoader.
type NewAudioGraphLoaderParams struct {
	AIClient ai.GraphAIClient
	Loader   loader.GraphFileLoader
}

// NewAudioGraphLoader creates a new loader that transcribes audio files to text.
func NewAudioGraphLoader(params NewAudioGraphLoaderParams) *AudioGraphLoader {
	return &AudioGraphLoader{
		aiClient: params.AIClient,
		loader:   params.Loader,
	}
}

// GetFileText reads the audio file and returns its transcription as text.
func (l *AudioGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
	rawAudio, err := l.loader.GetFileText(ctx, file)
	if err != nil {
		return nil, err
	}

	text, err := l.aiClient.GenerateAudioTranscription(ctx, rawAudio, "")
	if err != nil {
		return nil, err
	}

	return []byte(text), nil
}

// GetBase64 returns the raw audio file encoded as base64.
func (l *AudioGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	return l.loader.GetBase64(ctx, file)
}
