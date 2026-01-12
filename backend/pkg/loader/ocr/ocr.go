package ocr

import (
	"context"
	"encoding/base64"
	"fmt"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
	"strings"
	"sync"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

// OCRGraphLoader extracts text from images using AI vision models.
// It processes images in parallel and caches results for efficiency.
type OCRGraphLoader struct {
	loader   loader.GraphFileLoader
	aiClient ai.GraphAIClient
	parallel int

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewOCRGraphLoaderParams contains configuration for creating an OCRGraphLoader.
type NewOCRGraphLoaderParams struct {
	Loader   loader.GraphFileLoader
	AIClient ai.GraphAIClient
	Parallel int
}

// NewOCRGraphLoader creates a new OCR loader that extracts text from images using AI.
func NewOCRGraphLoader(params NewOCRGraphLoaderParams) *OCRGraphLoader {
	return &OCRGraphLoader{
		loader:   params.Loader,
		aiClient: params.AIClient,
		parallel: params.Parallel,
		cache:    make(map[string][]byte),
	}
}

// ProcessImages transcribes a slice of images to text using AI vision in parallel.
// Returns the concatenated text from all images.
func (l *OCRGraphLoader) ProcessImages(ctx context.Context, file loader.GraphFile, images [][]byte) ([]byte, error) {
	output := make([][]byte, len(images))
	outputMtx := sync.Mutex{}

	g, gCtx := errgroup.WithContext(ctx)
	g.SetLimit(l.parallel)

	for i, img := range images {
		idx := i
		image := img
		g.Go(func() error {
			logger.Debug("[OCR] Processing image", "number", idx+1, "total", len(images))
			prompt := ai.TranscribePrompt
			b64String := base64.StdEncoding.EncodeToString(image)
			filePrefix := "data:application/png;base64,"
			b64 := loader.GraphBase64{
				Base64:   b64String,
				FileType: filePrefix,
			}
			desc, err := l.aiClient.GenerateImageDescription(gCtx, prompt, b64)
			if err != nil {
				return err
			}

			outputMtx.Lock()
			output[idx] = []byte(desc)
			outputMtx.Unlock()

			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}

	var res strings.Builder
	for _, o := range output {
		fmt.Fprintf(&res, "%s\n", o)
	}

	result := []byte(res.String())

	return result, nil
}

// GetFileText loads an image file and extracts text using OCR. Results are cached.
func (l *OCRGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
	key := loader.CacheKey(file)

	l.cacheMu.RLock()
	if cached, ok := l.cache[key]; ok {
		l.cacheMu.RUnlock()
		return cached, nil
	}
	l.cacheMu.RUnlock()

	result, err, _ := l.group.Do(key, func() (any, error) {
		l.cacheMu.RLock()
		if cached, ok := l.cache[key]; ok {
			l.cacheMu.RUnlock()
			return cached, nil
		}
		l.cacheMu.RUnlock()

		content, err := l.loader.GetFileText(ctx, file)
		if err != nil {
			return nil, err
		}

		input := make([][]byte, 0)
		input = append(input, content)
		output, err := l.ProcessImages(ctx, file, input)
		if err != nil {
			return nil, err
		}

		l.cacheMu.Lock()
		l.cache[key] = output
		l.cacheMu.Unlock()

		return output, nil
	})

	if err != nil {
		return nil, err
	}

	return result.([]byte), nil
}

// GetBase64 returns the image encoded as base64.
func (l *OCRGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	return l.loader.GetBase64(ctx, file)
}

// InvalidateCache removes a specific file from the cache
func (l *OCRGraphLoader) InvalidateCache(file loader.GraphFile) {
	key := loader.CacheKey(file)
	l.cacheMu.Lock()
	delete(l.cache, key)
	l.cacheMu.Unlock()
}

// ClearCache removes all cached OCR results
func (l *OCRGraphLoader) ClearCache() {
	l.cacheMu.Lock()
	l.cache = make(map[string][]byte)
	l.cacheMu.Unlock()
}
