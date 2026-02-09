package util

import (
	"reflect"
	"strings"
	"testing"
)

func TestStreamCitationParser_EmitsCitationAcrossChunks(t *testing.T) {
	content, citations := collectParsedStream(t, []string{"Hello [[abc", "123]] world"})

	if content != "Hello  world" {
		t.Fatalf("unexpected content: %q", content)
	}

	expectedCitations := []string{"abc123"}
	if !reflect.DeepEqual(citations, expectedCitations) {
		t.Fatalf("unexpected citations: got %v want %v", citations, expectedCitations)
	}
}

func TestStreamCitationParser_PassesThroughInvalidCitation(t *testing.T) {
	content, citations := collectParsedStream(t, []string{"Result [[not valid]] token"})

	if content != "Result [[not valid]] token" {
		t.Fatalf("unexpected content: %q", content)
	}

	if len(citations) != 0 {
		t.Fatalf("expected no citations, got %v", citations)
	}
}

func TestStreamCitationParser_FlushesIncompleteCitation(t *testing.T) {
	content, citations := collectParsedStream(t, []string{"prefix [[unfinished"})

	if content != "prefix [[unfinished" {
		t.Fatalf("unexpected content: %q", content)
	}

	if len(citations) != 0 {
		t.Fatalf("expected no citations, got %v", citations)
	}
}

func TestStreamCitationParser_HandlesSingleBracketCarry(t *testing.T) {
	content, citations := collectParsedStream(t, []string{"x [", "[id_1]] y"})

	if content != "x  y" {
		t.Fatalf("unexpected content: %q", content)
	}

	expectedCitations := []string{"id_1"}
	if !reflect.DeepEqual(citations, expectedCitations) {
		t.Fatalf("unexpected citations: got %v want %v", citations, expectedCitations)
	}
}

func TestIsCitationID(t *testing.T) {
	tests := []struct {
		name  string
		id    string
		valid bool
	}{
		{name: "empty", id: "", valid: false},
		{name: "nanoid chars", id: "abcDEF012_-", valid: true},
		{name: "space", id: "abc def", valid: false},
		{name: "bracket", id: "abc]", valid: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isCitationID(tc.id); got != tc.valid {
				t.Fatalf("isCitationID(%q) = %v, want %v", tc.id, got, tc.valid)
			}
		})
	}
}

func collectParsedStream(t *testing.T, chunks []string) (string, []string) {
	t.Helper()

	parser := StreamCitationParser{}
	contentParts := make([]string, 0)
	citations := make([]string, 0)

	emitContent := func(content string) error {
		contentParts = append(contentParts, content)
		return nil
	}
	emitCitation := func(citationID string) error {
		citations = append(citations, citationID)
		return nil
	}

	for _, chunk := range chunks {
		if err := parser.Consume(chunk, emitContent, emitCitation); err != nil {
			t.Fatalf("consume failed: %v", err)
		}
	}

	if err := parser.Flush(emitContent); err != nil {
		t.Fatalf("flush failed: %v", err)
	}

	return strings.Join(contentParts, ""), citations
}
