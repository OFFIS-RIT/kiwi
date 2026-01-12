package web

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"

	"codeberg.org/readeck/go-readability/v2"
	"golang.org/x/sync/singleflight"
)

// WebGraphLoader loads content from web URLs and extracts readable text.
// For HTML pages, it uses readability to extract the main content.
type WebGraphLoader struct {
	fallback loader.GraphFileLoader

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewWebGraphLoader creates a new web loader without a fallback loader.
func NewWebGraphLoader() WebGraphLoader {
	return WebGraphLoader{
		cache: make(map[string][]byte),
	}
}

// NewWebGraphLoaderWithLoader creates a web loader with a fallback for non-HTML content.
func NewWebGraphLoaderWithLoader(loader loader.GraphFileLoader) WebGraphLoader {
	return WebGraphLoader{
		fallback: loader,
		cache:    make(map[string][]byte),
	}
}

// GetFileText fetches a URL and extracts readable text content.
// For HTML pages, it uses readability to extract the main article content.
func (l *WebGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
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

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, file.FilePath, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch url: %w", err)
		}
		defer resp.Body.Close()

		contentType := resp.Header.Get("Content-Type")
		if strings.Contains(contentType, "text/html") {
			url, err := url.Parse(file.FilePath)
			if err != nil {
				return nil, fmt.Errorf("failed too parse url: %w", err)
			}
			article, err := readability.FromReader(resp.Body, url)
			if err != nil {
				return nil, fmt.Errorf("failed to parse html: %w", err)
			}
			var builder strings.Builder
			if err := article.RenderText(&builder); err != nil {
				return nil, fmt.Errorf("failed to render article text: %w", err)
			}

			return []byte(builder.String()), nil
		}

		if l.fallback != nil {
			return l.fallback.GetFileText(ctx, file)
		}

		result, err := io.ReadAll(resp.Body)
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

// GetBase64 fetches a URL and returns its content encoded as base64.
func (l *WebGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	resp, err := http.Get(file.FilePath)
	if err != nil {
		return loader.GraphBase64{}, fmt.Errorf("failed to fetch url: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return loader.GraphBase64{}, err
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		u, _ := url.Parse(file.FilePath)
		ext := path.Ext(u.Path)
		contentType = mime.TypeByExtension(ext)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
	}

	return loader.GraphBase64{
		Base64:   base64.StdEncoding.EncodeToString(data),
		FileType: fmt.Sprintf("data:%s;base64,", contentType),
	}, nil
}
