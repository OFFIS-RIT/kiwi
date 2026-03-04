package json

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const testEncoder = "cl100k_base"

func TestJSONChunker_Chunk_EmptyInput(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 100,
		Encoder:      testEncoder,
	})

	chunks, err := chunker.Chunk(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chunks != nil {
		t.Errorf("expected nil, got %v", chunks)
	}
}

func TestJSONChunker_Chunk_WhitespaceOnly(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 100,
		Encoder:      testEncoder,
	})

	chunks, err := chunker.Chunk(context.Background(), "   \n\n  ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chunks != nil {
		t.Errorf("expected nil, got %v", chunks)
	}
}

func TestJSONChunker_Chunk_SmallObjectSingleChunk(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 1000,
		Encoder:      testEncoder,
	})

	input := `{"name": "Alice", "age": 30, "city": "Berlin"}`
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	// Should return the original text since it fits.
	if chunks[0].Text != input {
		t.Errorf("expected original text, got: %q", chunks[0].Text)
	}
	if chunks[0].ID == "" {
		t.Error("chunk ID should not be empty")
	}
}

func TestJSONChunker_Chunk_SmallArraySingleChunk(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 1000,
		Encoder:      testEncoder,
	})

	input := `[1, 2, 3, 4, 5]`
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
}

func TestJSONChunker_Chunk_TopLevelObjectSplit(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 30,
		Encoder:      testEncoder,
	})

	// Build an object with multiple keys that won't fit in one chunk.
	obj := map[string]any{
		"users":    []any{"Alice", "Bob", "Charlie", "Dave", "Eve"},
		"settings": map[string]any{"theme": "dark", "language": "en", "timezone": "UTC"},
		"version":  "1.0.0",
	}
	input, _ := json.Marshal(obj)

	chunks, err := chunker.Chunk(context.Background(), string(input))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) < 2 {
		t.Fatalf("expected at least 2 chunks from top-level split, got %d", len(chunks))
	}

	// Each chunk should be valid JSON (possibly with a path prefix).
	for i, c := range chunks {
		text := c.Text
		// Strip path prefix if present.
		if strings.HasPrefix(text, "Path:") {
			text = text[strings.Index(text, "\n")+1:]
		}
		if !json.Valid([]byte(text)) {
			t.Errorf("chunk %d is not valid JSON: %q", i, text)
		}
	}

	// All unique IDs.
	ids := make(map[string]bool)
	for _, c := range chunks {
		if ids[c.ID] {
			t.Errorf("duplicate chunk ID: %s", c.ID)
		}
		ids[c.ID] = true
	}
}

func TestJSONChunker_Chunk_ArrayBatching(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 20,
		Encoder:      testEncoder,
	})

	// Array of objects — should batch elements together.
	var arr []any
	for i := 0; i < 10; i++ {
		arr = append(arr, map[string]any{
			"id":   i,
			"name": "User",
			"role": "admin",
		})
	}
	input, _ := json.Marshal(arr)

	chunks, err := chunker.Chunk(context.Background(), string(input))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}

	// Each chunk's JSON content should be a valid JSON array.
	for i, c := range chunks {
		text := c.Text
		if strings.HasPrefix(text, "Path:") {
			text = text[strings.Index(text, "\n")+1:]
		}
		if !json.Valid([]byte(text)) {
			t.Errorf("chunk %d is not valid JSON: %q", i, text)
		}
	}
}

func TestJSONChunker_Chunk_DeepNestingRecursive(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 30,
		Encoder:      testEncoder,
	})

	// Create a deeply nested object where a single top-level key exceeds the limit.
	obj := map[string]any{
		"metadata": map[string]any{
			"author":      "Alice",
			"description": "A long description that contains many words to ensure it takes up tokens",
			"tags":        []any{"tag1", "tag2", "tag3", "tag4", "tag5"},
			"nested": map[string]any{
				"level2a": "value_a with extra content here",
				"level2b": "value_b with extra content here",
				"level2c": "value_c with extra content here",
			},
		},
		"simple": "small",
	}
	input, _ := json.Marshal(obj)

	chunks, err := chunker.Chunk(context.Background(), string(input))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) < 2 {
		t.Fatalf("expected at least 2 chunks for deep nesting, got %d", len(chunks))
	}

	// Check that path-prefixed chunks exist for the nested structure.
	hasPath := false
	for _, c := range chunks {
		if strings.HasPrefix(c.Text, "Path:") {
			hasPath = true
			break
		}
	}
	if !hasPath {
		t.Error("expected at least one chunk with a Path: prefix from recursive splitting")
	}
}

func TestJSONChunker_Chunk_ScalarValue(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 100,
		Encoder:      testEncoder,
	})

	// A top-level scalar is valid JSON.
	chunks, err := chunker.Chunk(context.Background(), `"hello world"`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
}

func TestJSONChunker_Chunk_InvalidJSON(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 10,
		Encoder:      testEncoder,
	})

	// Invalid JSON should fall back to a single chunk.
	input := `{not valid json: [}`
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk for invalid JSON, got %d", len(chunks))
	}
	if chunks[0].Text != input {
		t.Errorf("expected original text, got: %q", chunks[0].Text)
	}
}

func TestJSONChunker_Chunk_InvalidEncoder(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 100,
		Encoder:      "invalid_encoder",
	})

	_, err := chunker.Chunk(context.Background(), `{"key": "value"}`)
	if err == nil {
		t.Error("expected error for invalid encoder")
	}
}

func TestJSONChunker_Chunk_LargeArray_AllElementsPreserved(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 30,
		Encoder:      testEncoder,
	})

	// Create array of unique elements.
	var arr []any
	for i := 0; i < 20; i++ {
		arr = append(arr, map[string]any{"id": i})
	}
	input, _ := json.Marshal(arr)

	chunks, err := chunker.Chunk(context.Background(), string(input))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Reconstruct all elements from chunks and verify all IDs are present.
	foundIDs := make(map[float64]bool)
	for _, c := range chunks {
		text := c.Text
		if strings.HasPrefix(text, "Path:") {
			text = text[strings.Index(text, "\n")+1:]
		}
		var parsed any
		if err := json.Unmarshal([]byte(text), &parsed); err != nil {
			t.Fatalf("chunk is not valid JSON: %v", err)
		}
		switch v := parsed.(type) {
		case []any:
			for _, elem := range v {
				if obj, ok := elem.(map[string]any); ok {
					if id, ok := obj["id"].(float64); ok {
						foundIDs[id] = true
					}
				}
			}
		case map[string]any:
			if id, ok := v["id"].(float64); ok {
				foundIDs[id] = true
			}
		}
	}

	for i := 0; i < 20; i++ {
		if !foundIDs[float64(i)] {
			t.Errorf("element with id %d missing from chunks", i)
		}
	}
}

func TestJSONChunker_Chunk_PrettyPrintedOutput(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 30,
		Encoder:      testEncoder,
	})

	obj := map[string]any{
		"key1": "value1",
		"key2": "value2",
		"key3": "value3",
		"key4": "value4",
		"key5": "value5",
		"key6": "value6",
	}
	input, _ := json.Marshal(obj)

	chunks, err := chunker.Chunk(context.Background(), string(input))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// When split, chunks should be pretty-printed (contain newlines + indentation).
	for i, c := range chunks {
		text := c.Text
		if strings.HasPrefix(text, "Path:") {
			text = text[strings.Index(text, "\n")+1:]
		}
		if !strings.Contains(text, "\n") {
			t.Errorf("chunk %d should be pretty-printed, got: %q", i, text)
		}
	}
}

func TestJSONChunker_Chunk_PathPrefix(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 20,
		Encoder:      testEncoder,
	})

	// Deep nesting that forces recursive split — child chunks should have path prefix.
	obj := map[string]any{
		"data": map[string]any{
			"a": strings.Repeat("x", 100),
			"b": strings.Repeat("y", 100),
			"c": strings.Repeat("z", 100),
		},
	}
	input, _ := json.Marshal(obj)

	chunks, err := chunker.Chunk(context.Background(), string(input))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for _, c := range chunks {
		if !strings.HasPrefix(c.Text, "Path: $.data") {
			t.Errorf("expected path prefix '$.data', got: %q", c.Text[:min(len(c.Text), 40)])
		}
	}
}

func TestJSONChunker_Chunk_TopLevelNoPathPrefix(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 15,
		Encoder:      testEncoder,
	})

	// Top-level split should not add a path prefix (path is "$").
	obj := map[string]any{
		"a": "value_a",
		"b": "value_b",
		"c": "value_c",
	}
	input, _ := json.Marshal(obj)

	chunks, err := chunker.Chunk(context.Background(), string(input))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for i, c := range chunks {
		if strings.HasPrefix(c.Text, "Path: $\n") {
			t.Errorf("chunk %d should not have root path prefix, got: %q", i, c.Text[:min(len(c.Text), 30)])
		}
	}
}

func TestNewJSONChunker(t *testing.T) {
	params := NewJSONChunkerParams{
		MaxChunkSize: 42,
		Encoder:      testEncoder,
	}
	chunker := NewJSONChunker(params)
	if chunker.maxChunkSize != 42 {
		t.Errorf("maxChunkSize = %d, want 42", chunker.maxChunkSize)
	}
	if chunker.encoder != testEncoder {
		t.Errorf("encoder = %q, want %q", chunker.encoder, testEncoder)
	}
}

func TestOrderedKeys(t *testing.T) {
	input := `{"zebra": 1, "alpha": 2, "middle": 3}`
	keys := orderedKeys([]byte(input))
	expected := []string{"zebra", "alpha", "middle"}
	if len(keys) != len(expected) {
		t.Fatalf("expected %d keys, got %d", len(expected), len(keys))
	}
	for i, k := range keys {
		if k != expected[i] {
			t.Errorf("key[%d] = %q, want %q", i, k, expected[i])
		}
	}
}

func TestJSONChunker_Chunk_PreservesTopLevelObjectKeyOrder(t *testing.T) {
	chunker := NewJSONChunker(NewJSONChunkerParams{
		MaxChunkSize: 10,
		Encoder:      testEncoder,
	})

	input := `{"zebra":"a","alpha":"b","middle":"c"}`
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks, got %d", len(chunks))
	}

	actualOrder := make([]string, 0, len(chunks))
	for _, c := range chunks {
		var obj map[string]any
		if err := json.Unmarshal([]byte(c.Text), &obj); err != nil {
			t.Fatalf("chunk is not valid object JSON: %v", err)
		}
		if len(obj) != 1 {
			t.Fatalf("expected one key per chunk, got %d in %q", len(obj), c.Text)
		}
		for key := range obj {
			actualOrder = append(actualOrder, key)
		}
	}

	expectedOrder := []string{"zebra", "alpha", "middle"}
	for i := range expectedOrder {
		if actualOrder[i] != expectedOrder[i] {
			t.Errorf("key order mismatch at index %d: got %q want %q", i, actualOrder[i], expectedOrder[i])
		}
	}
}

func TestPrettyMarshal(t *testing.T) {
	val := map[string]any{"key": "value"}
	result, err := prettyMarshal(val)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "  ") {
		t.Error("expected indented output")
	}
	if !json.Valid([]byte(result)) {
		t.Error("result should be valid JSON")
	}
}
