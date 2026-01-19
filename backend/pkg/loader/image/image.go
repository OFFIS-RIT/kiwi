package image

import (
	"context"
	"encoding/base64"
	"io"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
)

// ImageGraphLoader loads image files and generates text descriptions using an AI vision model.
type ImageGraphLoader struct {
	aiClient ai.GraphAIClient
	loader   loader.GraphFileLoader
}

// NewImageGraphLoaderParams contains configuration for creating an ImageGraphLoader.
type NewImageGraphLoaderParams struct {
	AIClient ai.GraphAIClient
	Loader   loader.GraphFileLoader
}

// NewImageGraphLoader creates a new loader that describes images using AI vision.
func NewImageGraphLoader(params NewImageGraphLoaderParams) *ImageGraphLoader {
	return &ImageGraphLoader{
		aiClient: params.AIClient,
		loader:   params.Loader,
	}
}

// GetFileText generates a text description of the image using AI vision.
func (l ImageGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
	base64, err := l.GetBase64(ctx, file)
	if err != nil {
		return nil, err
	}

	var prompt string
	prompt = ai.ImagePrompt

	text, err := (l.aiClient).GenerateImageDescription(ctx, prompt, base64)
	if err != nil {
		return nil, err
	}

	return []byte(text), nil
}

// GetFileTextFromIO generates a text description of an image provided as an io.Reader.
func GetFileTextFromIO(ctx context.Context, aiClient ai.GraphAIClient, input io.Reader) ([]byte, error) {
	content, err := io.ReadAll(input)
	if err != nil {
		return nil, err
	}

	b64String := base64.StdEncoding.EncodeToString(content)
	filePrefix := "data:image/png;base64,"
	b64Image := loader.GraphBase64{
		Base64:   b64String,
		FileType: filePrefix,
	}

	var prompt string
	prompt = ai.ImagePrompt

	text, err := aiClient.GenerateImageDescription(ctx, prompt, b64Image)
	if err != nil {
		return nil, err
	}

	return []byte(text), nil
}

// GetBase64 returns the image encoded as base64 with appropriate MIME type prefix.
func (l ImageGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	return l.loader.GetBase64(ctx, file)
}
