package util

import (
	"reflect"
	"testing"
)

func TestExtractCitationIDs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		text string
		want []string
	}{
		{
			name: "no citations",
			text: "hello world",
			want: []string{},
		},
		{
			name: "single citation",
			text: "source [[abc_123]]",
			want: []string{"abc_123"},
		},
		{
			name: "multiple citations keep order",
			text: "[[b]] and [[a]] and [[c]]",
			want: []string{"b", "a", "c"},
		},
		{
			name: "duplicate citations deduplicated",
			text: "[[a]] again [[a]]",
			want: []string{"a"},
		},
		{
			name: "invalid nested brackets ignored",
			text: "[[a[b]] and [[x]]",
			want: []string{"x"},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractCitationIDs(tc.text)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ExtractCitationIDs(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}
