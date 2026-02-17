package util

import "testing"

func TestSanitizePostgresText(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "plain utf8",
			input: "hello world",
			want:  "hello world",
		},
		{
			name:  "contains null byte",
			input: "hel\x00lo",
			want:  "hello",
		},
		{
			name:  "contains invalid utf8",
			input: string([]byte{'a', 0xff, 'b'}),
			want:  "ab",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizePostgresText(tt.input)
			if got != tt.want {
				t.Fatalf("unexpected sanitized value: got %q, want %q", got, tt.want)
			}
		})
	}
}
