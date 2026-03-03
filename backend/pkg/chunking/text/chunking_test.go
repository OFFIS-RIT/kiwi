package text

import (
	"strings"
	"testing"

	"github.com/pkoukk/tiktoken-go"
)

func newTestCounter(t *testing.T) *tokenCounter {
	t.Helper()
	enc, err := tiktoken.GetEncoding("cl100k_base")
	if err != nil {
		t.Fatalf("failed to get encoding: %v", err)
	}
	return newTokenCounter(enc)
}

func TestTokenCounter_EmptyString(t *testing.T) {
	counter := newTestCounter(t)
	if got := counter.count(""); got != 0 {
		t.Errorf("count(\"\") = %d, want 0", got)
	}
}

func TestTokenCounter_WhitespaceOnly(t *testing.T) {
	counter := newTestCounter(t)
	if got := counter.count("   \t\n  "); got != 0 {
		t.Errorf("count(whitespace) = %d, want 0", got)
	}
}

func TestTokenCounter_Caching(t *testing.T) {
	counter := newTestCounter(t)
	text := "Hello world"
	first := counter.count(text)
	second := counter.count(text)
	if first != second {
		t.Errorf("cached count mismatch: first=%d, second=%d", first, second)
	}
	if _, ok := counter.cache[text]; !ok {
		t.Error("expected text to be in cache")
	}
}

func TestTokenCounter_NonEmptyString(t *testing.T) {
	counter := newTestCounter(t)
	got := counter.count("Hello world")
	if got <= 0 {
		t.Errorf("count(\"Hello world\") = %d, want > 0", got)
	}
}

func TestJoinChunkParts(t *testing.T) {
	tests := []struct {
		name  string
		left  string
		right string
		want  string
	}{
		{"both empty", "", "", ""},
		{"left empty", "", "right", "right"},
		{"right empty", "left", "", "left"},
		{"both non-empty", "left", "right", "left\n\nright"},
		{"whitespace left", "  left  ", "right", "left\n\nright"},
		{"whitespace right", "left", "  right  ", "left\n\nright"},
		{"whitespace both", "  left  ", "  right  ", "left\n\nright"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := joinChunkParts(tt.left, tt.right)
			if got != tt.want {
				t.Errorf("joinChunkParts(%q, %q) = %q, want %q", tt.left, tt.right, got, tt.want)
			}
		})
	}
}

func TestSplitByDoubleEmptyLines(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{
			name: "empty string",
			text: "",
			want: nil,
		},
		{
			name: "whitespace only",
			text: "   \n  \n   ",
			want: nil,
		},
		{
			name: "no double empty lines",
			text: "line one\nline two\nline three",
			want: []string{"line one\nline two\nline three"},
		},
		{
			name: "single empty line preserved within block",
			text: "line one\n\nline two",
			want: []string{"line one\n\nline two"},
		},
		{
			name: "double empty line splits",
			text: "block one\n\n\nblock two",
			want: []string{"block one", "block two"},
		},
		{
			name: "triple empty line splits",
			text: "block one\n\n\n\nblock two",
			want: []string{"block one", "block two"},
		},
		{
			name: "multiple double empty splits",
			text: "a\n\n\nb\n\n\nc",
			want: []string{"a", "b", "c"},
		},
		{
			name: "leading double empty lines",
			text: "\n\n\ncontent",
			want: []string{"content"},
		},
		{
			name: "trailing double empty lines",
			text: "content\n\n\n",
			want: []string{"content"},
		},
		{
			name: "carriage return handling",
			text: "block one\r\n\r\n\r\nblock two",
			want: []string{"block one", "block two"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitByDoubleEmptyLines(tt.text)
			if !stringSlicesEqual(got, tt.want) {
				t.Errorf("splitByDoubleEmptyLines(%q)\ngot:  %v\nwant: %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestSplitByMarkdownHeadings(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{
			name: "empty string",
			text: "",
			want: nil,
		},
		{
			name: "whitespace only",
			text: "   \n  ",
			want: nil,
		},
		{
			name: "no headings",
			text: "just some text\nmore text",
			want: []string{"just some text\nmore text"},
		},
		{
			name: "single heading at start",
			text: "# Title\nSome content",
			want: []string{"# Title\nSome content"},
		},
		{
			name: "multiple headings",
			text: "# Title\nContent 1\n## Section\nContent 2",
			want: []string{"# Title\nContent 1", "## Section\nContent 2"},
		},
		{
			name: "heading levels 1-6",
			text: "# H1\ntext\n## H2\ntext\n### H3\ntext\n#### H4\ntext\n##### H5\ntext\n###### H6\ntext",
			want: []string{
				"# H1\ntext", "## H2\ntext", "### H3\ntext",
				"#### H4\ntext", "##### H5\ntext", "###### H6\ntext",
			},
		},
		{
			name: "content before first heading",
			text: "intro text\n# Heading\nbody",
			want: []string{"intro text", "# Heading\nbody"},
		},
		{
			name: "heading without content after",
			text: "# Heading1\n# Heading2",
			want: []string{"# Heading1", "# Heading2"},
		},
		{
			name: "hash without space is not heading",
			text: "#notaheading\nsome text",
			want: []string{"#notaheading\nsome text"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitByMarkdownHeadings(tt.text)
			if !stringSlicesEqual(got, tt.want) {
				t.Errorf("splitByMarkdownHeadings(%q)\ngot:  %v\nwant: %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestSplitBySemanticLevel(t *testing.T) {
	text := "block1\n\n\nblock2"

	t.Run("double empty level", func(t *testing.T) {
		got := splitBySemanticLevel(text, semanticSplitDoubleEmpty)
		if len(got) != 2 {
			t.Errorf("expected 2 parts, got %d: %v", len(got), got)
		}
	})

	t.Run("heading level on non-heading text", func(t *testing.T) {
		got := splitBySemanticLevel("no headings here", semanticSplitMarkdownHeading)
		if len(got) != 1 {
			t.Errorf("expected 1 part, got %d: %v", len(got), got)
		}
	})

	t.Run("default level returns original", func(t *testing.T) {
		got := splitBySemanticLevel("text", semanticSplitLevel(99))
		if len(got) != 1 || got[0] != "text" {
			t.Errorf("unexpected result: %v", got)
		}
	})
}

func TestIsEmptyLine(t *testing.T) {
	tests := []struct {
		line string
		want bool
	}{
		{"", true},
		{"   ", true},
		{"\t", true},
		{"a", false},
		{" a ", false},
	}

	for _, tt := range tests {
		t.Run(tt.line, func(t *testing.T) {
			if got := isEmptyLine(tt.line); got != tt.want {
				t.Errorf("isEmptyLine(%q) = %v, want %v", tt.line, got, tt.want)
			}
		})
	}
}

func TestIsSentenceClosingRune(t *testing.T) {
	closing := []rune{'"', '\'', ')', ']', '}', '\u00BB', '\u201C', '\u201D'}
	for _, r := range closing {
		if !isSentenceClosingRune(r) {
			t.Errorf("expected %q to be closing rune", r)
		}
	}

	nonClosing := []rune{'a', '1', '.', '!', '?', ' ', '-'}
	for _, r := range nonClosing {
		if isSentenceClosingRune(r) {
			t.Errorf("expected %q to NOT be closing rune", r)
		}
	}
}

func TestEndsWithSentenceTerminator(t *testing.T) {
	tests := []struct {
		sentence string
		want     bool
	}{
		{"", false},
		{"   ", false},
		{"Hello world.", true},
		{"Really?", true},
		{"Wow!", true},
		{"End.\"", true},
		{"End.')", true},
		{"No terminator", false},
		{"Trailing space. ", true},
		{"End?\")", true},
		{"Just closing))", false},
	}

	for _, tt := range tests {
		t.Run(tt.sentence, func(t *testing.T) {
			if got := endsWithSentenceTerminator(tt.sentence); got != tt.want {
				t.Errorf("endsWithSentenceTerminator(%q) = %v, want %v", tt.sentence, got, tt.want)
			}
		})
	}
}

func TestIsSentenceBoundaryAtRune(t *testing.T) {
	tests := []struct {
		name string
		text string
		idx  int
		want bool
	}{
		{"exclamation", "Hello!", 5, true},
		{"question", "Hello?", 5, true},
		{"period end of sentence", "Hello.", 5, true},
		{"out of bounds negative", "abc", -1, false},
		{"out of bounds high", "abc", 3, false},
		{"regular letter", "abc", 1, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runes := []rune(tt.text)
			if got := isSentenceBoundaryAtRune(runes, tt.idx); got != tt.want {
				t.Errorf("isSentenceBoundaryAtRune(%q, %d) = %v, want %v", tt.text, tt.idx, got, tt.want)
			}
		})
	}
}

func TestIsDateOrDecimalDot(t *testing.T) {
	tests := []struct {
		name string
		text string
		idx  int
		want bool
	}{
		{"decimal", "3.14", 1, true},
		{"date-like", "01.01.2024", 2, true},
		{"date second dot", "01.01.2024", 5, true},
		{"not date", "Hello.", 5, false},
		{"single digit before dot", "x.", 1, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runes := []rune(tt.text)
			if got := isDateOrDecimalDot(runes, tt.idx); got != tt.want {
				t.Errorf("isDateOrDecimalDot(%q, %d) = %v, want %v", tt.text, tt.idx, got, tt.want)
			}
		})
	}
}

func TestIsAbbreviationDot(t *testing.T) {
	tests := []struct {
		name string
		text string
		idx  int
		want bool
	}{
		{"known abbreviation dr", "Dr. Smith", 2, true},
		{"known abbreviation etc", "etc. more", 3, true},
		{"known abbreviation mr", "Mr. Jones", 2, true},
		{"not abbreviation", "Hello.", 5, false},
		{"single letter abbreviation A.B.", "A.B.", 1, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runes := []rune(tt.text)
			if got := isAbbreviationDot(runes, tt.idx); got != tt.want {
				t.Errorf("isAbbreviationDot(%q, %d) = %v, want %v", tt.text, tt.idx, got, tt.want)
			}
		})
	}
}

func TestIsNumericListingDot(t *testing.T) {
	tests := []struct {
		name string
		text string
		idx  int
		want bool
	}{
		{"at start of line", "1. First item", 1, true},
		{"after colon", ": 2. Second", 3, true},
		{"no space adjacent letter still listing at start", "1.a", 1, true},
		{"no digit before", "a. text", 1, false},
		{"no letter after", "1. ", 1, false},
		{"after semicolon", "; 3. Third", 3, true},
		{"mid sentence not listing", "word 1. more", 6, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runes := []rune(tt.text)
			if got := isNumericListingDot(runes, tt.idx); got != tt.want {
				t.Errorf("isNumericListingDot(%q, %d) = %v, want %v", tt.text, tt.idx, got, tt.want)
			}
		})
	}
}

func TestPreviousNonSpaceRuneIndex(t *testing.T) {
	runes := []rune("a  b")
	tests := []struct {
		start int
		want  int
	}{
		{3, 3},
		{2, 0},
		{0, 0},
		{-1, -1},
	}

	for _, tt := range tests {
		got := previousNonSpaceRuneIndex(runes, tt.start)
		if got != tt.want {
			t.Errorf("previousNonSpaceRuneIndex(start=%d) = %d, want %d", tt.start, got, tt.want)
		}
	}
}

func TestNextNonSpaceRuneIndex(t *testing.T) {
	runes := []rune("a  b")
	tests := []struct {
		start int
		want  int
	}{
		{0, 0},
		{1, 3},
		{3, 3},
		{4, -1},
	}

	for _, tt := range tests {
		got := nextNonSpaceRuneIndex(runes, tt.start)
		if got != tt.want {
			t.Errorf("nextNonSpaceRuneIndex(start=%d) = %d, want %d", tt.start, got, tt.want)
		}
	}
}

func TestPreviousNonSpaceRuneIndex_AllSpaces(t *testing.T) {
	runes := []rune("   ")
	if got := previousNonSpaceRuneIndex(runes, 2); got != -1 {
		t.Errorf("expected -1 for all-space input, got %d", got)
	}
}

func TestNextNonSpaceRuneIndex_AllSpaces(t *testing.T) {
	runes := []rune("   ")
	if got := nextNonSpaceRuneIndex(runes, 0); got != -1 {
		t.Errorf("expected -1 for all-space input, got %d", got)
	}
}

func TestSplitLineIntoSentences(t *testing.T) {
	tests := []struct {
		name string
		line string
		want []string
	}{
		{
			name: "empty line",
			line: "",
			want: nil,
		},
		{
			name: "single sentence no terminator",
			line: "Hello world",
			want: []string{"Hello world"},
		},
		{
			name: "single sentence with period",
			line: "Hello world.",
			want: []string{"Hello world."},
		},
		{
			name: "two sentences",
			line: "First sentence. Second sentence.",
			want: []string{"First sentence.", "Second sentence."},
		},
		{
			name: "question and exclamation",
			line: "Is this real? Yes it is!",
			want: []string{"Is this real?", "Yes it is!"},
		},
		{
			name: "abbreviation not split",
			line: "Dr. Smith went home.",
			want: []string{"Dr. Smith went home."},
		},
		{
			name: "decimal number not split",
			line: "The value is 3.14 meters.",
			want: []string{"The value is 3.14 meters."},
		},
		{
			name: "date not split",
			line: "The date is 01.01.2024 today.",
			want: []string{"The date is 01.01.2024 today."},
		},
		{
			name: "multiple terminators",
			line: "Really?! Yes.",
			want: []string{"Really?!", "Yes."},
		},
		{
			name: "closing quotes after terminator",
			line: `He said "hello." She left.`,
			want: []string{`He said "hello."`, `She left.`},
		},
		{
			name: "numeric listing not split",
			line: "1. First item",
			want: []string{"1. First item"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitLineIntoSentences(tt.line)
			if !stringSlicesEqual(got, tt.want) {
				t.Errorf("splitLineIntoSentences(%q)\ngot:  %v\nwant: %v", tt.line, got, tt.want)
			}
		})
	}
}

func TestSplitIntoSentences(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{
			name: "empty string",
			text: "",
			want: nil,
		},
		{
			name: "single sentence",
			text: "Hello world.",
			want: []string{"Hello world."},
		},
		{
			name: "multiple sentences across lines",
			text: "First sentence.\nSecond sentence.",
			want: []string{"First sentence.", "Second sentence."},
		},
		{
			name: "paragraph break splits",
			text: "Paragraph one.\n\nParagraph two.",
			want: []string{"Paragraph one.", "Paragraph two."},
		},
		{
			name: "sentence spanning lines",
			text: "This is a long\nsentence that spans.",
			want: []string{"This is a long sentence that spans."},
		},
		{
			name: "markdown table preserved",
			text: "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
			want: []string{"| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"},
		},
		{
			name: "table followed by text",
			text: "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nSome text.",
			want: []string{"| A | B |\n| --- | --- |\n| 1 | 2 |", "Some text."},
		},
		{
			name: "pipe in non-table line",
			text: "A | B without delimiter row",
			want: []string{"A | B without delimiter row"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SplitIntoSentences(tt.text)
			if !stringSlicesEqual(got, tt.want) {
				t.Errorf("SplitIntoSentences(%q)\ngot:  %v\nwant: %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestSplitIntoSegments(t *testing.T) {
	t.Run("empty text", func(t *testing.T) {
		got := splitIntoSegments("")
		if len(got) != 0 {
			t.Errorf("expected 0 segments, got %d", len(got))
		}
	})

	t.Run("simple text", func(t *testing.T) {
		got := splitIntoSegments("Hello world. Goodbye world.")
		if len(got) != 2 {
			t.Errorf("expected 2 segments, got %d: %v", len(got), segmentTexts(got))
		}
	})

	t.Run("markdown table creates table row segments", func(t *testing.T) {
		text := "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"
		got := splitIntoSegments(text)
		tableRowCount := 0
		for _, seg := range got {
			if seg.kind == segmentTableRow {
				tableRowCount++
			}
		}
		if tableRowCount != 2 {
			t.Errorf("expected 2 table row segments, got %d: %v", tableRowCount, segmentTexts(got))
		}
	})

	t.Run("table row has header and tableID", func(t *testing.T) {
		text := "| A | B |\n| --- | --- |\n| 1 | 2 |"
		got := splitIntoSegments(text)
		for _, seg := range got {
			if seg.kind == segmentTableRow {
				if seg.tableHeader == "" {
					t.Error("table row segment should have non-empty tableHeader")
				}
				if seg.tableID <= 0 {
					t.Error("table row segment should have positive tableID")
				}
			}
		}
	})

	t.Run("table without data rows", func(t *testing.T) {
		text := "| A | B |\n| --- | --- |\n\nSome text."
		got := splitIntoSegments(text)
		found := false
		for _, seg := range got {
			if strings.Contains(seg.text, "| A | B |") {
				found = true
			}
		}
		if !found {
			t.Errorf("expected table header to appear in segments: %v", segmentTexts(got))
		}
	})

	t.Run("text before and after table", func(t *testing.T) {
		text := "Before.\n| A | B |\n| --- | --- |\n| 1 | 2 |\nAfter."
		got := splitIntoSegments(text)
		if len(got) < 3 {
			t.Errorf("expected at least 3 segments, got %d: %v", len(got), segmentTexts(got))
		}
	})

	t.Run("pipe line without delimiter row is text segment", func(t *testing.T) {
		text := "A | B\nC | D"
		got := splitIntoSegments(text)
		for _, seg := range got {
			if seg.kind == segmentTableRow {
				t.Error("pipe lines without delimiter should not be table rows")
			}
		}
	})

	t.Run("table ended by non-pipe line", func(t *testing.T) {
		text := "| A | B |\n| --- | --- |\n| 1 | 2 |\nNot a table row."
		got := splitIntoSegments(text)
		hasTableRow := false
		hasText := false
		for _, seg := range got {
			if seg.kind == segmentTableRow {
				hasTableRow = true
			}
			if seg.kind == segmentText && strings.Contains(seg.text, "Not a table row") {
				hasText = true
			}
		}
		if !hasTableRow || !hasText {
			t.Errorf("expected both table row and text segments, got: %v", segmentTexts(got))
		}
	})

	t.Run("table at end of input without newline", func(t *testing.T) {
		text := "| A | B |\n| --- | --- |\n| 1 | 2 |"
		got := splitIntoSegments(text)
		if len(got) == 0 {
			t.Error("expected segments for table at end of input")
		}
	})

	t.Run("empty line between sentences", func(t *testing.T) {
		text := "First.\n\nSecond."
		got := splitIntoSegments(text)
		if len(got) != 2 {
			t.Errorf("expected 2 segments, got %d: %v", len(got), segmentTexts(got))
		}
	})
}

func TestBuildChunkText(t *testing.T) {
	t.Run("text segments joined with space", func(t *testing.T) {
		segments := []segment{
			{text: "Hello.", kind: segmentText},
			{text: "World.", kind: segmentText},
		}
		got := buildChunkText(segments, 0, 2)
		if got != "Hello. World." {
			t.Errorf("got %q, want %q", got, "Hello. World.")
		}
	})

	t.Run("table rows joined with newline", func(t *testing.T) {
		segments := []segment{
			{text: "| 1 | 2 |", kind: segmentTableRow, tableHeader: "| A | B |\n| --- | --- |", tableID: 1},
			{text: "| 3 | 4 |", kind: segmentTableRow, tableHeader: "| A | B |\n| --- | --- |", tableID: 1},
		}
		got := buildChunkText(segments, 0, 2)
		want := "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("table header only added once per tableID", func(t *testing.T) {
		segments := []segment{
			{text: "| 1 | 2 |", kind: segmentTableRow, tableHeader: "| H |\n| --- |", tableID: 1},
			{text: "| 3 | 4 |", kind: segmentTableRow, tableHeader: "| H |\n| --- |", tableID: 1},
		}
		got := buildChunkText(segments, 0, 2)
		if strings.Count(got, "| H |") != 1 {
			t.Errorf("expected header once, got: %q", got)
		}
	})

	t.Run("mixed text and table segments", func(t *testing.T) {
		segments := []segment{
			{text: "Before.", kind: segmentText},
			{text: "| 1 | 2 |", kind: segmentTableRow, tableHeader: "| A | B |\n| --- | --- |", tableID: 1},
			{text: "After.", kind: segmentText},
		}
		got := buildChunkText(segments, 0, 3)
		if !strings.Contains(got, "Before.") || !strings.Contains(got, "| 1 | 2 |") || !strings.Contains(got, "After.") {
			t.Errorf("missing expected content in: %q", got)
		}
	})

	t.Run("empty range", func(t *testing.T) {
		segments := []segment{{text: "test", kind: segmentText}}
		got := buildChunkText(segments, 0, 0)
		if got != "" {
			t.Errorf("expected empty string for empty range, got %q", got)
		}
	})

	t.Run("partial range", func(t *testing.T) {
		segments := []segment{
			{text: "A.", kind: segmentText},
			{text: "B.", kind: segmentText},
			{text: "C.", kind: segmentText},
		}
		got := buildChunkText(segments, 1, 3)
		if got != "B. C." {
			t.Errorf("got %q, want %q", got, "B. C.")
		}
	})
}

func TestChunkBySentenceOrTable(t *testing.T) {
	counter := newTestCounter(t)

	t.Run("empty text", func(t *testing.T) {
		got := chunkBySentenceOrTable("", counter, 100)
		if len(got) != 0 {
			t.Errorf("expected nil, got %v", got)
		}
	})

	t.Run("maxTokens zero returns one segment per sentence", func(t *testing.T) {
		got := chunkBySentenceOrTable("First sentence. Second sentence.", counter, 0)
		if len(got) != 2 {
			t.Errorf("expected 2 chunks, got %d: %v", len(got), got)
		}
	})

	t.Run("fits in single chunk", func(t *testing.T) {
		got := chunkBySentenceOrTable("Short.", counter, 100)
		if len(got) != 1 {
			t.Errorf("expected 1 chunk, got %d: %v", len(got), got)
		}
	})

	t.Run("multiple chunks when exceeding limit", func(t *testing.T) {
		text := strings.Repeat("This is a sentence. ", 50)
		got := chunkBySentenceOrTable(text, counter, 10)
		if len(got) <= 1 {
			t.Errorf("expected multiple chunks, got %d", len(got))
		}
	})
}

func TestChunkTextRecursively(t *testing.T) {
	counter := newTestCounter(t)

	t.Run("empty text", func(t *testing.T) {
		got := chunkTextRecursively("", counter, 100, semanticSplitDoubleEmpty)
		if len(got) != 0 {
			t.Errorf("expected nil, got %v", got)
		}
	})

	t.Run("whitespace only", func(t *testing.T) {
		got := chunkTextRecursively("   \n\n  ", counter, 100, semanticSplitDoubleEmpty)
		if len(got) != 0 {
			t.Errorf("expected nil, got %v", got)
		}
	})

	t.Run("text fits in max tokens", func(t *testing.T) {
		got := chunkTextRecursively("Hello world", counter, 100, semanticSplitDoubleEmpty)
		if len(got) != 1 || got[0] != "Hello world" {
			t.Errorf("expected [\"Hello world\"], got %v", got)
		}
	})

	t.Run("text split by double empty lines", func(t *testing.T) {
		text := "Block one with some content.\n\n\nBlock two with some content."
		got := chunkTextRecursively(text, counter, 10, semanticSplitDoubleEmpty)
		if len(got) < 2 {
			t.Errorf("expected at least 2 chunks, got %d: %v", len(got), got)
		}
	})

	t.Run("maxTokens zero delegates to sentence chunking", func(t *testing.T) {
		got := chunkTextRecursively("First. Second.", counter, 0, semanticSplitDoubleEmpty)
		if len(got) != 2 {
			t.Errorf("expected 2 chunks, got %d: %v", len(got), got)
		}
	})

	t.Run("falls through levels when no split possible", func(t *testing.T) {
		text := strings.Repeat("Word ", 200) + "."
		got := chunkTextRecursively(text, counter, 20, semanticSplitDoubleEmpty)
		if len(got) == 0 {
			t.Error("expected non-empty result")
		}
		for i, chunk := range got {
			if strings.TrimSpace(chunk) == "" {
				t.Errorf("chunk %d is empty", i)
			}
		}
	})

	t.Run("already at sentence level", func(t *testing.T) {
		text := "First sentence. Second sentence. Third sentence."
		got := chunkTextRecursively(text, counter, 5, semanticSplitSentence)
		if len(got) < 2 {
			t.Errorf("expected multiple chunks at sentence level, got %d: %v", len(got), got)
		}
	})
}

func TestMergeTinyChunks(t *testing.T) {
	counter := newTestCounter(t)

	t.Run("nil input", func(t *testing.T) {
		got := mergeTinyChunks(nil, counter, 100)
		if got != nil {
			t.Errorf("expected nil, got %v", got)
		}
	})

	t.Run("single chunk", func(t *testing.T) {
		got := mergeTinyChunks([]string{"hello"}, counter, 100)
		if len(got) != 1 {
			t.Errorf("expected 1 chunk, got %d", len(got))
		}
	})

	t.Run("maxTokens zero returns as-is", func(t *testing.T) {
		chunks := []string{"a", "b"}
		got := mergeTinyChunks(chunks, counter, 0)
		if len(got) != 2 {
			t.Errorf("expected 2 chunks, got %d", len(got))
		}
	})

	t.Run("tiny first chunk merged into second", func(t *testing.T) {
		chunks := []string{"A", "Hello world this is a longer text."}
		got := mergeTinyChunks(chunks, counter, 1000)
		if len(got) != 1 {
			t.Errorf("expected 1 merged chunk, got %d: %v", len(got), got)
		}
	})

	t.Run("tiny chunk merged into previous", func(t *testing.T) {
		chunks := []string{"Hello world this is a longer text.", "B"}
		got := mergeTinyChunks(chunks, counter, 1000)
		if len(got) != 1 {
			t.Errorf("expected 1 merged chunk, got %d: %v", len(got), got)
		}
	})

	t.Run("empty chunks removed", func(t *testing.T) {
		chunks := []string{"hello", "", "world"}
		got := mergeTinyChunks(chunks, counter, 1000)
		for _, c := range got {
			if strings.TrimSpace(c) == "" {
				t.Error("empty chunk should have been removed")
			}
		}
	})

	t.Run("all tiny chunks merge together", func(t *testing.T) {
		chunks := []string{"a", "b", "c"}
		got := mergeTinyChunks(chunks, counter, 1000)
		if len(got) != 1 {
			t.Errorf("expected 1 merged chunk, got %d: %v", len(got), got)
		}
	})
}

func TestMarkdownTableDelimiterPattern(t *testing.T) {
	matches := []string{
		"| --- | --- |",
		"|---|---|",
		"| :--- | ---: |",
		"| :---: | :---: |",
		"  | ---- | ----- |  ",
		"--- | ---",
	}

	noMatches := []string{
		"| -- | -- |",
		"just text",
		"| --- |",
		"",
	}

	for _, s := range matches {
		if !markdownTableDelimiterPattern.MatchString(s) {
			t.Errorf("expected match for %q", s)
		}
	}

	for _, s := range noMatches {
		if markdownTableDelimiterPattern.MatchString(s) {
			t.Errorf("expected no match for %q", s)
		}
	}
}

func TestMarkdownHeadingPattern(t *testing.T) {
	matches := []string{
		"# Heading",
		"## Heading",
		"### Heading",
		"###### Heading",
		"  # Indented",
		"   # Three spaces",
		"####### Seven hashes matches via greedy regex",
		"#NoSpace matches since regex uses \\S+",
	}

	noMatches := []string{
		"    # Four spaces",
		"# ",
		"",
	}

	for _, s := range matches {
		if !markdownHeadingPattern.MatchString(s) {
			t.Errorf("expected match for %q", s)
		}
	}

	for _, s := range noMatches {
		if markdownHeadingPattern.MatchString(s) {
			t.Errorf("expected no match for %q", s)
		}
	}
}

func TestTextChunker_Chunk(t *testing.T) {
	chunker := NewTextChunker(NewTextChunkerParams{
		MaxChunkSize: 50,
		Encoder:      "cl100k_base",
	})

	t.Run("empty input", func(t *testing.T) {
		chunks, err := chunker.Chunk(nil, "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if chunks != nil {
			t.Errorf("expected nil, got %v", chunks)
		}
	})

	t.Run("whitespace input", func(t *testing.T) {
		chunks, err := chunker.Chunk(nil, "   \n\n   ")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if chunks != nil {
			t.Errorf("expected nil, got %v", chunks)
		}
	})

	t.Run("short text returns single chunk", func(t *testing.T) {
		chunks, err := chunker.Chunk(nil, "Hello world.")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(chunks) != 1 {
			t.Fatalf("expected 1 chunk, got %d", len(chunks))
		}
		if chunks[0].Text != "Hello world." {
			t.Errorf("unexpected text: %q", chunks[0].Text)
		}
		if chunks[0].ID == "" {
			t.Error("chunk ID should not be empty")
		}
	})

	t.Run("long text produces multiple chunks", func(t *testing.T) {
		text := strings.Repeat("This is a moderately long sentence that should use some tokens. ", 40)
		chunks, err := chunker.Chunk(nil, text)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(chunks) <= 1 {
			t.Errorf("expected multiple chunks, got %d", len(chunks))
		}
		ids := make(map[string]bool)
		for _, c := range chunks {
			if ids[c.ID] {
				t.Errorf("duplicate chunk ID: %s", c.ID)
			}
			ids[c.ID] = true
		}
	})

	t.Run("invalid encoder returns error", func(t *testing.T) {
		badChunker := NewTextChunker(NewTextChunkerParams{
			MaxChunkSize: 50,
			Encoder:      "invalid_encoder",
		})
		_, err := badChunker.Chunk(nil, "test")
		if err == nil {
			t.Error("expected error for invalid encoder")
		}
	})

	t.Run("markdown with headings and tables", func(t *testing.T) {
		text := "# Introduction\n\nSome intro text.\n\n## Data\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n## Conclusion\n\nFinal thoughts."
		chunks, err := chunker.Chunk(nil, text)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(chunks) == 0 {
			t.Error("expected at least one chunk")
		}
		for i, c := range chunks {
			if strings.TrimSpace(c.Text) == "" {
				t.Errorf("chunk %d is empty", i)
			}
		}
	})
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func segmentTexts(segs []segment) []string {
	texts := make([]string, len(segs))
	for i, s := range segs {
		texts[i] = s.text
	}
	return texts
}
