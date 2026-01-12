package doc

import (
	"context"
	"encoding/base64"
	"io"
	"path/filepath"
	"strings"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/ocr"

	"golang.org/x/sync/singleflight"
)

const docXMLMax = 50 << 20

// DocGraphLoader loads Word documents (.docx, .doc) and extracts their text content.
// It supports optional OCR processing for scanned documents.
type DocGraphLoader struct {
	loader loader.GraphFileLoader
	ocr    *ocr.OCRGraphLoader

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewDocOcrGraphLoader creates a document loader with OCR support for scanned documents.
func NewDocOcrGraphLoader(loader loader.GraphFileLoader, ocr *ocr.OCRGraphLoader) *DocGraphLoader {
	return &DocGraphLoader{
		loader: loader,
		ocr:    ocr,
		cache:  make(map[string][]byte),
	}
}

// NewDocGraphLoader creates a document loader that extracts text directly from docx XML.
func NewDocGraphLoader(loader loader.GraphFileLoader) *DocGraphLoader {
	return &DocGraphLoader{
		loader: loader,
		cache:  make(map[string][]byte),
	}
}

// GetFileText extracts text content from a Word document.
// If OCR is configured, the document is converted to images and processed via OCR.
func (l *DocGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
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

		if l.ocr == nil {
			return parseDocx(content)
		}

		ext := filepath.Ext(file.FilePath)
		ext = strings.ReplaceAll(ext, ".", "")
		images, err := loader.TransformDocToImages(content, ext)
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

// GetFileTextFromIO extracts text content from a Word document provided as an io.Reader.
func GetFileTextFromIO(ctx context.Context, input io.Reader) ([]byte, error) {
	content, err := io.ReadAll(input)
	if err != nil {
		return nil, err
	}

	return parseDocx(content)
}

// GetBase64 returns the raw document encoded as base64.
func (l *DocGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	content, err := l.loader.GetFileText(ctx, file)
	if err != nil {
		return loader.GraphBase64{}, err
	}

	enc := base64.StdEncoding.EncodeToString(content)

	return loader.GraphBase64{
		Base64:   enc,
		FileType: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,",
	}, nil
}
