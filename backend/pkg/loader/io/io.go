package io

import (
	"context"
	"encoding/base64"
	"fmt"
	"mime"
	"os"
	"strings"
	"sync"

	"kiwi/pkg/loader"

	"golang.org/x/sync/singleflight"
)

func getBase64Prefix(filePath string) string {
	nameSplit := strings.Split(filePath, ".")
	if len(nameSplit) < 2 {
		return "data:application/octet-stream;base64,"
	}
	ext := nameSplit[len(nameSplit)-1]
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return fmt.Sprintf("data:%s;base64,", mimeType)
}

// IOGraphFileLoader loads files directly from the local filesystem with caching.
type IOGraphFileLoader struct {
	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewIOGraphFileLoader creates a new filesystem-based file loader.
func NewIOGraphFileLoader() *IOGraphFileLoader {
	return &IOGraphFileLoader{
		cache: make(map[string][]byte),
	}
}

// GetFileText reads the file content from the filesystem. Results are cached.
func (l *IOGraphFileLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
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

		result, err := os.ReadFile(file.FilePath)
		if err != nil {
			return nil, err
		}

		l.cacheMu.Lock()
		l.cache[key] = result
		l.cacheMu.Unlock()

		return result, nil
	})

	return result.([]byte), err
}

// GetBas64 reads the file and returns it encoded as base64 with appropriate MIME type.
func (l *IOGraphFileLoader) GetBas64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	f, err := l.GetFileText(ctx, file)
	if err != nil {
		return loader.GraphBase64{}, err
	}

	result := base64.StdEncoding.EncodeToString(f)
	fileTypePrefix := getBase64Prefix(file.FilePath)
	return loader.GraphBase64{
		Base64:   result,
		FileType: fileTypePrefix,
	}, nil
}
