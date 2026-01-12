package pptx

import (
	"context"
	"encoding/base64"
	"kiwi/pkg/loader"
	"kiwi/pkg/loader/ocr"
	"sync"

	"golang.org/x/sync/singleflight"
)

// PPTXGraphLoader loads PowerPoint files and extracts their text content via OCR.
type PPTXGraphLoader struct {
	loader loader.GraphFileLoader
	ocr    *ocr.OCRGraphLoader

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewPPTXOcrGraphLoader creates a PowerPoint loader that extracts text via OCR.
func NewPPTXOcrGraphLoader(loader loader.GraphFileLoader, ocr *ocr.OCRGraphLoader) *PPTXGraphLoader {
	return &PPTXGraphLoader{
		loader: loader,
		ocr:    ocr,
		cache:  make(map[string][]byte),
	}
}

// GetFileText extracts text from a PowerPoint file by converting slides to images and using OCR.
func (l *PPTXGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
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

		// Transform PPTX to images
		images, err := loader.TransformDocToImages(content, "pptx")
		if err != nil {
			return nil, err
		}

		result, err := l.ocr.ProcessImages(ctx, file, images)
		if err != nil {
			return nil, err
		}

		l.cacheMu.Lock()
		l.cache[key] = result
		l.cacheMu.Unlock()

		return result, nil
	})

	if err != nil {
		return nil, err
	}

	return result.([]byte), nil
}

// GetBase64 returns the PowerPoint file encoded as base64.
func (l *PPTXGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	content, err := l.loader.GetFileText(ctx, file)
	if err != nil {
		return loader.GraphBase64{}, err
	}

	enc := base64.StdEncoding.EncodeToString(content)

	return loader.GraphBase64{
		Base64:   enc,
		FileType: "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,",
	}, nil
}
