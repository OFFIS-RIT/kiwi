package json

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/chunking"
	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/pkoukk/tiktoken-go"
)

// JSONChunker implements a 3-tier chunking strategy for JSON values:
//
//  1. If the entire JSON fits within maxChunkSize tokens, return it as a single chunk.
//  2. Otherwise, split by top-level keys (objects) or top-level elements (arrays),
//     grouping entries that fit together into one chunk.
//  3. If any single top-level entry still exceeds the limit, recursively split
//     its children with path-aware context prefixes.
type JSONChunker struct {
	maxChunkSize int
	encoder      string
}

type NewJSONChunkerParams struct {
	MaxChunkSize int
	Encoder      string
}

func NewJSONChunker(params NewJSONChunkerParams) *JSONChunker {
	return &JSONChunker{
		maxChunkSize: params.MaxChunkSize,
		encoder:      params.Encoder,
	}
}

func (c *JSONChunker) Chunk(_ context.Context, input string) ([]chunking.Chunk, error) {
	enc, err := tiktoken.GetEncoding(c.encoder)
	if err != nil {
		return nil, err
	}

	text := strings.TrimSpace(input)
	if text == "" {
		return nil, nil
	}

	tokenCount := func(s string) int {
		return len(enc.Encode(s, nil, nil))
	}

	// Tier 1: entire document fits in one chunk.
	if tokenCount(text) <= c.maxChunkSize {
		id, err := gonanoid.New()
		if err != nil {
			return nil, err
		}
		return []chunking.Chunk{{ID: id, Text: text}}, nil
	}

	// Parse the JSON to determine structure.
	var raw any
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		// Not valid JSON — fall back to returning as a single chunk.
		id, err := gonanoid.New()
		if err != nil {
			return nil, err
		}
		return []chunking.Chunk{{ID: id, Text: text}}, nil
	}

	var textChunks []string

	switch v := raw.(type) {
	case map[string]any:
		textChunks, err = c.chunkObject(v, "$", orderedKeys([]byte(text)), tokenCount)
	case []any:
		textChunks, err = c.chunkArray(v, "$", tokenCount)
	default:
		// Scalar at top level — single chunk.
		id, err := gonanoid.New()
		if err != nil {
			return nil, err
		}
		return []chunking.Chunk{{ID: id, Text: text}}, nil
	}

	if err != nil {
		return nil, err
	}

	result := make([]chunking.Chunk, len(textChunks))
	for i, t := range textChunks {
		id, err := gonanoid.New()
		if err != nil {
			return nil, err
		}
		result[i] = chunking.Chunk{ID: id, Text: t}
	}

	return result, nil
}

// chunkObject splits a JSON object by its keys, grouping keys that fit together
// into one chunk. For top-level objects, keyOrder should come from the original
// JSON text. If empty, deterministic lexical order is used.
func (c *JSONChunker) chunkObject(
	obj map[string]any,
	path string,
	keyOrder []string,
	tokenCount func(string) int,
) ([]string, error) {
	keys := objectKeysInOrder(obj, keyOrder)

	var chunks []string
	currentEntries := make(map[string]any)
	currentTokens := 0

	flush := func() error {
		if len(currentEntries) == 0 {
			return nil
		}
		text, err := prettyMarshal(currentEntries)
		if err != nil {
			return err
		}
		if path != "$" {
			text = fmt.Sprintf("Path: %s\n%s", path, text)
		}
		chunks = append(chunks, text)
		currentEntries = make(map[string]any)
		currentTokens = 0
		return nil
	}

	for _, key := range keys {
		val, ok := obj[key]
		if !ok {
			continue
		}
		entry := map[string]any{key: val}
		entryText, err := prettyMarshal(entry)
		if err != nil {
			return nil, err
		}
		entryTokens := tokenCount(entryText)

		// Tier 3: single entry exceeds the limit — recurse into its value.
		if entryTokens > c.maxChunkSize {
			// Flush any accumulated entries first.
			if err := flush(); err != nil {
				return nil, err
			}
			childPath := fmt.Sprintf("%s.%s", path, key)
			subChunks, err := c.chunkValue(val, childPath, tokenCount)
			if err != nil {
				return nil, err
			}
			chunks = append(chunks, subChunks...)
			continue
		}

		// Tier 2: accumulate entries that fit together.
		if currentTokens+entryTokens > c.maxChunkSize && len(currentEntries) > 0 {
			if err := flush(); err != nil {
				return nil, err
			}
		}

		currentEntries[key] = val
		currentTokens += entryTokens
	}

	if err := flush(); err != nil {
		return nil, err
	}

	return chunks, nil
}

// chunkArray splits a JSON array by batching elements that fit together.
// If a single element exceeds the limit, it is recursively split.
func (c *JSONChunker) chunkArray(
	arr []any,
	path string,
	tokenCount func(string) int,
) ([]string, error) {
	var chunks []string
	var currentElements []any
	currentTokens := 0

	flush := func() error {
		if len(currentElements) == 0 {
			return nil
		}
		text, err := prettyMarshal(currentElements)
		if err != nil {
			return err
		}
		if path != "$" {
			text = fmt.Sprintf("Path: %s\n%s", path, text)
		}
		chunks = append(chunks, text)
		currentElements = nil
		currentTokens = 0
		return nil
	}

	for i, elem := range arr {
		elemText, err := prettyMarshal(elem)
		if err != nil {
			return nil, err
		}
		elemTokens := tokenCount(elemText)

		// Single element exceeds limit — recurse.
		if elemTokens > c.maxChunkSize {
			if err := flush(); err != nil {
				return nil, err
			}
			childPath := fmt.Sprintf("%s[%d]", path, i)
			subChunks, err := c.chunkValue(elem, childPath, tokenCount)
			if err != nil {
				return nil, err
			}
			chunks = append(chunks, subChunks...)
			continue
		}

		if currentTokens+elemTokens > c.maxChunkSize && len(currentElements) > 0 {
			if err := flush(); err != nil {
				return nil, err
			}
		}

		currentElements = append(currentElements, elem)
		currentTokens += elemTokens
	}

	if err := flush(); err != nil {
		return nil, err
	}

	return chunks, nil
}

// chunkValue dispatches to the appropriate chunker based on value type.
// Scalar values or values that fit within the limit are returned as-is with a path prefix.
func (c *JSONChunker) chunkValue(
	val any,
	path string,
	tokenCount func(string) int,
) ([]string, error) {
	switch v := val.(type) {
	case map[string]any:
		return c.chunkObject(v, path, nil, tokenCount)
	case []any:
		return c.chunkArray(v, path, tokenCount)
	default:
		// Scalar — return as a single chunk with path context.
		text, err := prettyMarshal(val)
		if err != nil {
			return nil, err
		}
		return []string{fmt.Sprintf("Path: %s\n%s", path, text)}, nil
	}
}

func objectKeysInOrder(obj map[string]any, preferred []string) []string {
	if len(preferred) == 0 {
		keys := make([]string, 0, len(obj))
		for key := range obj {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return keys
	}

	keys := make([]string, 0, len(obj))
	seen := make(map[string]struct{}, len(obj))
	for _, key := range preferred {
		if _, ok := obj[key]; !ok {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		keys = append(keys, key)
		seen[key] = struct{}{}
	}

	if len(keys) == len(obj) {
		return keys
	}

	missing := make([]string, 0, len(obj)-len(keys))
	for key := range obj {
		if _, ok := seen[key]; ok {
			continue
		}
		missing = append(missing, key)
	}
	sort.Strings(missing)

	return append(keys, missing...)
}

// orderedKeys extracts key order from JSON object bytes.
func orderedKeys(data []byte) []string {
	dec := json.NewDecoder(strings.NewReader(string(data)))

	// Read opening '{'
	t, err := dec.Token()
	if err != nil {
		return nil
	}
	if delim, ok := t.(json.Delim); !ok || delim != '{' {
		return nil
	}

	var keys []string
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			break
		}
		if key, ok := t.(string); ok {
			keys = append(keys, key)
			// Skip the value.
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				break
			}
		}
	}

	return keys
}

// prettyMarshal serializes a value as indented JSON.
func prettyMarshal(v any) (string, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "", err
	}
	return string(b), nil
}
