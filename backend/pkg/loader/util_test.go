package loader

import "testing"

func TestNormalizeMarkdownImageDescriptions(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name: "duplicate description with normalized whitespace",
			input: "Intro\n![Garden with a winding stone path and central fountain.](image.jpg)\n\nGarden with a winding stone path\nand central fountain.\n\nNext.",
			expected: "Intro\n\n<image>Garden with a winding stone path\nand central fountain.</image>\n\nNext.",
		},
		{
			name:     "no duplicate description",
			input:    "Intro\n![Simple diagram of layout](image.png)\nNext.",
			expected: "Intro\n<image>Simple diagram of layout</image>\nNext.",
		},
		{
			name: "multiple image tags",
			input: "![First image description with detail.](a.png)\nFirst image description with detail.\n\n![Second image description with detail](b.png)\nMore text.",
			expected: "\n<image>First image description with detail.</image>\n\n<image>Second image description with detail</image>\nMore text.",
		},
		{
			name: "duplicate description after intervening text",
			input: "Intro\n![Quiet harbor with fishing boats near cliffs.](image.jpg)\nAdditional notes appear here.\nSome other line.\n\nQuiet harbor with fishing boats near cliffs.\nMore text.",
			expected: "Intro\nAdditional notes appear here.\nSome other line.\n\n<image>Quiet harbor with fishing boats near cliffs.</image>\nMore text.",
		},
		{
			name: "extra markdown text without duplicate",
			input: "Start\n![Night skyline with neon signs and crowded streets.](scene.png)\nDifferent sentence follows with no exact match.\nEnd.",
			expected: "Start\n<image>Night skyline with neon signs and crowded streets.</image>\nDifferent sentence follows with no exact match.\nEnd.",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := NormalizeMarkdownImageDescriptions(test.input)
			if got != test.expected {
				t.Fatalf("unexpected output:\nexpected: %q\nreceived: %q", test.expected, got)
			}
		})
	}
}
