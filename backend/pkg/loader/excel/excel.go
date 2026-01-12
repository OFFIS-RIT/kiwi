package excel

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"strings"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader/csv"

	"golang.org/x/sync/singleflight"
)

// ExcelGraphLoader loads and parses Excel files (.xlsx, .xls) by converting
// them to CSV format using unoconv, then parsing the CSV content.
type ExcelGraphLoader struct {
	loader loader.GraphFileLoader

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewExcelGraphLoader creates a new ExcelGraphLoader with the given base loader.
func NewExcelGraphLoader(baseLoader loader.GraphFileLoader) *ExcelGraphLoader {
	return &ExcelGraphLoader{
		loader: baseLoader,
		cache:  make(map[string][]byte),
	}
}

// GetFileText retrieves the Excel file, converts it to CSV, and returns parsed text.
// For multi-sheet workbooks, all sheets are concatenated with sheet name headers.
func (l *ExcelGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
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

		ext := filepath.Ext(file.FilePath)
		ext = strings.ReplaceAll(ext, ".", "")
		ext = strings.ToLower(ext)

		csvSheets, err := loader.TransformExcelToCsv(content, ext)
		if err != nil {
			return nil, err
		}

		var result []byte
		for sheetName, csvContent := range csvSheets {
			parsed, err := csv.ParseCSV(csvContent)
			if err != nil {
				continue
			}

			if len(result) > 0 {
				result = append(result, '\n')
			}

			if len(csvSheets) > 1 {
				header := "--- " + sheetName + " ---\n"
				result = append(result, []byte(header)...)
			}

			result = append(result, parsed...)
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

// GetBase64 returns the base64 encoded Excel content.
func (l *ExcelGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	content, err := l.loader.GetFileText(ctx, file)
	if err != nil {
		return loader.GraphBase64{}, err
	}

	enc := base64.StdEncoding.EncodeToString(content)

	ext := filepath.Ext(file.FilePath)
	ext = strings.ToLower(ext)

	var mimeType string
	switch ext {
	case ".xlsx":
		mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".xls":
		mimeType = "application/vnd.ms-excel"
	default:
		mimeType = "application/octet-stream"
	}

	return loader.GraphBase64{
		Base64:   enc,
		FileType: "data:" + mimeType + ";base64,",
	}, nil
}

// ExcelSheet represents a single sheet from an Excel workbook.
type ExcelSheet struct {
	Name    string
	Content []byte
}

// GetSheets retrieves the Excel file and returns each sheet as a separate document.
// This is useful when you want to process each sheet as an individual document.
func (l *ExcelGraphLoader) GetSheets(ctx context.Context, file loader.GraphFile) ([]ExcelSheet, error) {
	content, err := l.loader.GetFileText(ctx, file)
	if err != nil {
		return nil, err
	}

	ext := filepath.Ext(file.FilePath)
	ext = strings.ReplaceAll(ext, ".", "")
	ext = strings.ToLower(ext)

	csvSheets, err := loader.TransformExcelToCsv(content, ext)
	if err != nil {
		return nil, err
	}

	sheets := make([]ExcelSheet, 0, len(csvSheets))
	for sheetName, csvContent := range csvSheets {
		parsed, err := csv.ParseCSV(csvContent)
		if err != nil {
			continue
		}

		sheets = append(sheets, ExcelSheet{
			Name:    sheetName,
			Content: parsed,
		})
	}

	return sheets, nil
}
