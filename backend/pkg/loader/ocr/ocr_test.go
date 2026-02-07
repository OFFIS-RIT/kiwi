package ocr

import (
	"strings"
	"testing"
)

func TestNormalizeOCRMarkup(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		contains    []string
		notContains []string
	}{
		{
			name:  "converts html table to markdown table",
			input: `<table border="1"><tbody><tr><td>Name</td><td>Value</td></tr><tr><td>A</td><td>1</td></tr></tbody></table>`,
			contains: []string{
				"| Name | Value |",
				"| --- | --- |",
				"| A | 1 |",
			},
			notContains: []string{"<table", "<td"},
		},
		{
			name:        "converts styled div to markdown box",
			input:       `<div style="text-align:right">28. 09. 2017</div>`,
			contains:    []string{"> 28. 09. 2017"},
			notContains: []string{"<div"},
		},
		{
			name:  "keeps tables outside box quoting",
			input: `<div style="display:flex"><table><tr><td>Key</td><td>Val</td></tr><tr><td>A</td><td>B</td></tr></table></div>`,
			contains: []string{
				"| Key | Val |",
				"| A | B |",
			},
			notContains: []string{"> | Key | Val |"},
		},
		{
			name:  "preserves metadata tags",
			input: `<doc-header><div style="font-weight:bold">Header Text</div></doc-header><p>Body Text</p>`,
			contains: []string{
				"<doc-header>Header Text</doc-header>",
				"Body Text",
			},
			notContains: []string{"<div"},
		},
		{
			name:  "preserves metadata tags when only wrappers are present",
			input: `<doc-header><span>Header Text</span></doc-header><doc-footer>Footer Text</doc-footer>`,
			contains: []string{
				"<doc-header>Header Text</doc-header>",
				"<doc-footer>Footer Text</doc-footer>",
			},
			notContains: []string{"<span"},
		},
		{
			name:  "preserves metadata tags with whitespace inside tag brackets",
			input: `< doc-header ><span>Header Text</span></ doc-header >< doc-footer>Footer Text</ doc-footer>`,
			contains: []string{
				"<doc-header>Header Text</doc-header>",
				"<doc-footer>Footer Text</doc-footer>",
			},
			notContains: []string{"<span"},
		},
		{
			name:  "handles container-closing tags in OCR content",
			input: `</body></html><doc-header>Header Text</doc-header><p>Body Text</p>`,
			contains: []string{
				"<doc-header>Header Text</doc-header>",
				"Body Text",
			},
			notContains: []string{"<p", "<body", "<html"},
		},
		{
			name: "keeps plain markdown without html tags",
			input: `# Heading

This is **markdown** text.`,
			contains: []string{
				"# Heading",
				"This is **markdown** text.",
			},
		},
		{
			name: "converts html embedded in markdown text",
			input: `Intro paragraph.

<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>

Outro paragraph.`,
			contains: []string{
				"Intro paragraph.",
				"| A | B |",
				"| 1 | 2 |",
				"Outro paragraph.",
			},
			notContains: []string{"<table", "<th", "<td"},
		},
		{
			name: "converts markdown with embedded div and table fragments",
			input: `Intro paragraph.

<div style="text-align:right">28.09.2017</div>

<table><tr><th>Key</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>

Outro paragraph.`,
			contains: []string{
				"Intro paragraph.",
				"> 28.09.2017",
				"| Key | Value |",
				"| A | 1 |",
				"Outro paragraph.",
			},
			notContains: []string{"<div", "<table", "<th", "<td"},
		},
		{
			name:  "normalizes metadata tags with uppercase and whitespace",
			input: `< DOC-HEADER >Header Text</ DOC-HEADER >`,
			contains: []string{
				"<doc-header>Header Text</doc-header>",
			},
		},
		{
			name:  "normalizes metadata tags with attributes and whitespace",
			input: `< doc-header class="x" data-id="1" >Header Text</ doc-header >`,
			contains: []string{
				"<doc-header>Header Text</doc-header>",
			},
			notContains: []string{"< doc-header", "data-id="},
		},
		{
			name: "converts mixed html structures",
			input: `<div style="text-align:right">28.09.2017</div>
<h2>Bebauungsplan</h2>
<table><tr><td>Amt</td><td>Status</td></tr><tr><td>Stadtplanung</td><td>oeffentlich</td></tr></table>`,
			contains: []string{
				"> 28.09.2017",
				"## Bebauungsplan",
				"| Amt | Status |",
				"| Stadtplanung | oeffentlich |",
			},
			notContains: []string{"<table", "<h2", "<div"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeOCRMarkup(tt.input)

			for _, want := range tt.contains {
				if !strings.Contains(got, want) {
					t.Fatalf("normalizeOCRMarkup() missing %q in output %q", want, got)
				}
			}

			for _, unwanted := range tt.notContains {
				if strings.Contains(got, unwanted) {
					t.Fatalf("normalizeOCRMarkup() should not contain %q in output %q", unwanted, got)
				}
			}
		})
	}
}
