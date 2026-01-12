package csv

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	"fmt"
	"io"
	"strings"
	"sync"

	"kiwi/pkg/loader"

	"golang.org/x/sync/singleflight"
)

// CSVGraphLoader loads and parses CSV files into text format.
type CSVGraphLoader struct {
	loader loader.GraphFileLoader

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewCSVGraphLoader creates a new CSVGraphLoader with the given base loader.
func NewCSVGraphLoader(loader loader.GraphFileLoader) *CSVGraphLoader {
	return &CSVGraphLoader{
		loader: loader,
		cache:  make(map[string][]byte),
	}
}

// GetFileText retrieves and parses the CSV file content.
func (l *CSVGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
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

		parsed, err := ParseCSV(content)
		if err != nil {
			return nil, err
		}

		l.cacheMu.Lock()
		l.cache[key] = parsed
		l.cacheMu.Unlock()

		return parsed, nil
	})

	if err != nil {
		return nil, err
	}

	return result.([]byte), nil
}

// GetBase64 returns the base64 encoded CSV content.
func (l *CSVGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	content, err := l.loader.GetFileText(ctx, file)
	if err != nil {
		return loader.GraphBase64{}, err
	}

	enc := base64.StdEncoding.EncodeToString(content)

	return loader.GraphBase64{
		Base64:   enc,
		FileType: "data:text/csv;base64,",
	}, nil
}

// ParseCSV parses CSV content and returns it as clean comma-separated text.
// It handles proper escaping/quoting and normalizes the output.
func ParseCSV(content []byte) ([]byte, error) {
	reader := csv.NewReader(bytes.NewReader(content))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true

	var output strings.Builder
	lineNum := 0

	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue
		}

		isEmpty := true
		for _, field := range record {
			if strings.TrimSpace(field) != "" {
				isEmpty = false
				break
			}
		}
		if isEmpty {
			continue
		}

		if lineNum > 0 {
			output.WriteByte('\n')
		}

		for i, field := range record {
			if i > 0 {
				output.WriteByte(',')
			}
			if strings.ContainsAny(field, ",\n\"") {
				output.WriteString(quoteField(field))
			} else {
				output.WriteString(field)
			}
		}
		lineNum++
	}

	if output.Len() == 0 {
		return nil, fmt.Errorf("CSV file is empty or contains no valid data")
	}

	result := output.String()
	if !strings.HasSuffix(result, "\n") {
		result += "\n"
	}

	return []byte(result), nil
}

// quoteField properly quotes a CSV field that contains special characters.
func quoteField(field string) string {
	escaped := strings.ReplaceAll(field, "\"", "\"\"")
	return "\"" + escaped + "\""
}
