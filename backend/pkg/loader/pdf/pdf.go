package pdf

import (
	"context"
	"encoding/base64"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/ocr"
	"sync"

	"golang.org/x/sync/singleflight"
)

// PDFGraphLoader loads PDF files and extracts their text content.
// It supports optional OCR processing for scanned PDFs.
type PDFGraphLoader struct {
	loader loader.GraphFileLoader
	ocr    *ocr.OCRGraphLoader

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewPDFOcrGraphLoader creates a PDF loader with OCR support for scanned documents.
func NewPDFOcrGraphLoader(loader loader.GraphFileLoader, ocr *ocr.OCRGraphLoader) *PDFGraphLoader {
	return &PDFGraphLoader{
		loader: loader,
		ocr:    ocr,
		cache:  make(map[string][]byte),
	}
}

// NewPDFGraphLoader creates a PDF loader that extracts text directly from PDF content.
func NewPDFGraphLoader(loader loader.GraphFileLoader) *PDFGraphLoader {
	return &PDFGraphLoader{
		loader: loader,
		cache:  make(map[string][]byte),
	}
}

// GetFileText extracts text from a PDF file.
// If OCR is configured, the PDF is converted to images and processed via OCR.
func (l *PDFGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
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
			return parsePDF(content)
		}

		images, err := loader.TransformPdfToImages(ctx, content)
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

// GetBase64 returns the PDF encoded as base64.
func (l *PDFGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	content, err := l.loader.GetFileText(ctx, file)
	if err != nil {
		return loader.GraphBase64{}, err
	}

	result := base64.StdEncoding.EncodeToString(content)
	filePrefix := "data:application/pdf;base64,"
	return loader.GraphBase64{
		Base64:   result,
		FileType: filePrefix,
	}, nil
}
