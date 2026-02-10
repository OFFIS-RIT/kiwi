package util

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSanitizePostgresText(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "keeps valid text unchanged",
			input: "hello world",
			want:  "hello world",
		},
		{
			name:  "removes invalid utf8 bytes",
			input: string([]byte{'A', 0xe2, '.', '.', 'B'}),
			want:  "A..B",
		},
		{
			name:  "removes null bytes",
			input: "prefix\x00suffix",
			want:  "prefixsuffix",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizePostgresText(tt.input)

			if got != tt.want {
				t.Fatalf("unexpected sanitized value: got %q, want %q", got, tt.want)
			}

			if !utf8.ValidString(got) {
				t.Fatalf("sanitized value must be valid utf-8: %q", got)
			}

			if strings.Contains(got, "\x00") {
				t.Fatalf("sanitized value must not contain null bytes: %q", got)
			}
		})
	}
}
