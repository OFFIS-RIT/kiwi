package graph

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/pkoukk/tiktoken-go"
)

func TestSplitIntoSentences(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{
			name: "empty input",
			text: "",
			want: []string(nil),
		},
		{
			name: "single sentence",
			text: "Hello world.",
			want: []string{"Hello world."},
		},
		{
			name: "multiple sentences",
			text: "Hello world. This is a test! How are you?",
			want: []string{
				"Hello world.",
				"This is a test!",
				"How are you?",
			},
		},
		{
			name: "sentences with empty lines",
			text: "First sentence.\n\nSecond sentence.\n\nThird sentence.",
			want: []string{
				"First sentence.",
				"Second sentence.",
				"Third sentence.",
			},
		},
		{
			name: "multi-line sentence",
			text: "This is a long\nsentence that spans\nmultiple lines.",
			want: []string{"This is a long sentence that spans multiple lines."},
		},
		{
			name: "markdown table as single sentence",
			text: "Header1 | Header2\n------- | -------\nValue1  | Value2\nValue3  | Value4",
			want: []string{
				"Header1 | Header2\n------- | -------\nValue1  | Value2\nValue3  | Value4",
			},
		},
		{
			name: "text with table",
			text: "Introduction text.\nHeader1 | Header2\n------- | -------\nValue1  | Value2\nConclusion text.",
			want: []string{
				"Introduction text.",
				"Header1 | Header2\n------- | -------\nValue1  | Value2",
				"Conclusion text.",
			},
		},
		{
			name: "table without delimiter",
			text: "Header1 | Header2\nValue1  | Value2",
			want: []string{
				"Header1 | Header2",
				"Value1  | Value2",
			},
		},
		{
			name: "text with no punctuation",
			text: "Just some text without punctuation\nMore text here",
			want: []string{"Just some text without punctuation More text here"},
		},
		{
			name: "mixed content",
			text: "Start here.\n\n| Col1 | Col2 |\n|------|------|\n| Val1 | Val2 |\n\nEnd here!",
			want: []string{
				"Start here.",
				"| Col1 | Col2 |\n|------|------|\n| Val1 | Val2 |",
				"End here!",
			},
		},
		{
			name: "numeric listing should stay in same sentence",
			text: "Today we discuss three points. 1. First item 2. Second item 3. Third item. Done!",
			want: []string{
				"Today we discuss three points.",
				"1. First item 2. Second item 3. Third item.",
				"Done!",
			},
		},
		{
			name: "date should not split into multiple sentences",
			text: "Beratungsfolge am 19. 10. 2017 bleibt bestehen. Der Beschluss folgt.",
			want: []string{
				"Beratungsfolge am 19. 10. 2017 bleibt bestehen.",
				"Der Beschluss folgt.",
			},
		},
		{
			name: "single-letter abbreviation should stay intact",
			text: "Dies gilt z. B. fuer den Test. Danach folgt mehr.",
			want: []string{
				"Dies gilt z. B. fuer den Test.",
				"Danach folgt mehr.",
			},
		},
		{
			name: "uppercase single-letter chain before lowercase should split",
			text: "A. B. folgt ein beispiel.",
			want: []string{
				"A. B.",
				"folgt ein beispiel.",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitIntoSentences(tt.text)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("splitIntoSentences() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestGetUnitsFromText(t *testing.T) {
	tests := []struct {
		name      string
		text      string
		maxTokens int
		want      []processUnit
	}{
		{
			name:      "single sentence under limit",
			text:      "Hello world.",
			maxTokens: 10,
			want: []processUnit{
				{
					fileID: "test.txt",
					start:  0,
					end:    1,
					text:   "Hello world.",
				},
			},
		},
		{
			name:      "multiple sentences under limit",
			text:      "First sentence. Second sentence.",
			maxTokens: 20,
			want: []processUnit{
				{
					fileID: "test.txt",
					start:  0,
					end:    1,
					text:   "First sentence. Second sentence.",
				},
			},
		},
		{
			name:      "sentences split by token limit",
			text:      "First sentence. Second sentence. Third sentence.",
			maxTokens: 1,
			want: []processUnit{
				{
					fileID: "test.txt",
					start:  0,
					end:    1,
					text:   "First sentence.",
				},
				{
					fileID: "test.txt",
					start:  1,
					end:    2,
					text:   "Second sentence.",
				},
				{
					fileID: "test.txt",
					start:  2,
					end:    3,
					text:   "Third sentence.",
				},
			},
		},
		{
			name:      "table as single unit",
			text:      "| Header1 | Header2 |\n|---------|---------|\n| Value1  | Value2  |",
			maxTokens: 10,
			want: []processUnit{
				{
					fileID: "test.txt",
					start:  0,
					end:    1,
					text:   "| Header1 | Header2 |\n|---------|---------|\n| Value1  | Value2  |",
				},
			},
		},
		{
			name:      "empty text",
			text:      "",
			maxTokens: 10,
			want:      []processUnit{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			file := loader.GraphFile{
				ID:        "test.txt",
				FilePath:  "test.txt",
				MaxTokens: tt.maxTokens,
				Loader:    &mockLoader{text: tt.text},
			}

			got, err := getUnitsFromText(context.Background(), file, "cl100k_base")
			if err != nil {
				t.Fatalf("getUnitsFromText() error = %v", err)
			}

			if len(got) != len(tt.want) {
				t.Errorf("getUnitsFromText() returned %d units, want %d", len(got), len(tt.want))
				return
			}

			for i, unit := range got {
				expected := tt.want[i]

				if unit.fileID != expected.fileID {
					t.Errorf("unit[%d].fileID = %s, want %s", i, unit.fileID, expected.fileID)
				}

				if unit.start != expected.start {
					t.Errorf("unit[%d].start = %d, want %d", i, unit.start, expected.start)
				}
				if unit.end != expected.end {
					t.Errorf("unit[%d].end = %d, want %d", i, unit.end, expected.end)
				}

				gotText := strings.TrimSpace(unit.text)
				wantText := strings.TrimSpace(expected.text)
				if gotText != wantText {
					t.Errorf("unit[%d].text = %q, want %q", i, gotText, wantText)
				}
			}
		})
	}
}

func TestTransformIntoUnitsSemanticFallbacks(t *testing.T) {
	t.Run("finish sentence over token limit", func(t *testing.T) {
		words := make([]string, 0, 1300)
		for i := 0; i < 1300; i++ {
			words = append(words, "word")
		}
		text := strings.Join(words, " ")

		units, err := transformIntoUnits(text, "test.txt", "cl100k_base", 1)
		if err != nil {
			t.Fatalf("transformIntoUnits error = %v", err)
		}

		if len(units) != 1 {
			t.Fatalf("transformIntoUnits returned %d units, want 1", len(units))
		}

		if strings.TrimSpace(units[0].text) != strings.TrimSpace(text) {
			t.Fatalf("unit text mismatch for over-limit sentence")
		}
	})

	t.Run("split table rows with repeated header", func(t *testing.T) {
		enc, err := tiktoken.GetEncoding("cl100k_base")
		if err != nil {
			t.Fatalf("GetEncoding error = %v", err)
		}

		header := "| Col1 | Col2 |"
		delimiter := "|------|------|"
		rows := []string{"| A | B |", "| C | D |"}
		text := strings.Join([]string{header, delimiter, rows[0], rows[1]}, "\n")

		maxTokens := len(enc.Encode(strings.Join([]string{header, delimiter, rows[0]}, "\n"), nil, nil))
		if len(enc.Encode(text, nil, nil)) <= maxTokens {
			t.Fatalf("test setup invalid: table should split across rows")
		}

		units, err := transformIntoUnits(text, "test.txt", "cl100k_base", maxTokens)
		if err != nil {
			t.Fatalf("transformIntoUnits error = %v", err)
		}

		if len(units) != len(rows) {
			t.Fatalf("transformIntoUnits returned %d units, want %d", len(units), len(rows))
		}

		for i, row := range rows {
			want := strings.Join([]string{header, delimiter, row}, "\n")
			if strings.TrimSpace(units[i].text) != want {
				t.Fatalf("unit[%d].text = %q, want %q", i, strings.TrimSpace(units[i].text), want)
			}
		}
	})

	t.Run("merge tiny trailing chunk", func(t *testing.T) {
		enc, err := tiktoken.GetEncoding("cl100k_base")
		if err != nil {
			t.Fatalf("GetEncoding error = %v", err)
		}

		left := strings.Repeat("Left sentence. ", 35)
		right := strings.Repeat("Right sentence. ", 35)
		tiny := "Tail."
		text := strings.Join([]string{left, right, tiny}, "\n\n")

		maxTokens := len(enc.Encode(left, nil, nil))
		rightTokens := len(enc.Encode(right, nil, nil))
		if rightTokens > maxTokens {
			maxTokens = rightTokens
		}

		units, err := transformIntoUnits(text, "test.txt", "cl100k_base", maxTokens)
		if err != nil {
			t.Fatalf("transformIntoUnits error = %v", err)
		}

		if len(units) != 2 {
			t.Fatalf("transformIntoUnits returned %d units, want 2", len(units))
		}

		if !strings.Contains(units[1].text, tiny) {
			t.Fatalf("expected trailing tiny chunk to merge into previous chunk")
		}
	})

	t.Run("split on markdown headings", func(t *testing.T) {
		enc, err := tiktoken.GetEncoding("cl100k_base")
		if err != nil {
			t.Fatalf("GetEncoding error = %v", err)
		}

		first := "# Heading 1\n" + strings.Repeat("Alpha sentence. ", 30)
		second := "## Heading 2\n" + strings.Repeat("Beta sentence. ", 30)
		text := first + "\n" + second

		maxTokens := len(enc.Encode(first, nil, nil))
		if len(enc.Encode(text, nil, nil)) <= maxTokens {
			t.Fatalf("test setup invalid: heading sections should exceed max when combined")
		}

		units, err := transformIntoUnits(text, "test.txt", "cl100k_base", maxTokens)
		if err != nil {
			t.Fatalf("transformIntoUnits error = %v", err)
		}

		if len(units) < 2 {
			t.Fatalf("transformIntoUnits returned %d units, want at least 2", len(units))
		}

		if !strings.Contains(units[0].text, "# Heading 1") {
			t.Fatalf("first chunk should include first heading")
		}
		if !strings.Contains(units[1].text, "## Heading 2") {
			t.Fatalf("second chunk should include second heading")
		}
	})
}

type mockLoader struct {
	text string
}

func (m *mockLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
	return []byte(m.text), nil
}

func (m *mockLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	return loader.GraphBase64{}, nil
}

func TestIsCSVHeader(t *testing.T) {
	tests := []struct {
		name string
		rows []string
		want bool
	}{
		{
			name: "single row returns false",
			rows: []string{"a,b,c"},
			want: false,
		},
		{
			name: "header with text, data with numbers",
			rows: []string{"Name,Age,City", "John,25,NYC", "Jane,30,LA"},
			want: true,
		},
		{
			name: "all numeric data",
			rows: []string{"1,2,3", "4,5,6", "7,8,9"},
			want: true,
		},
		{
			name: "common header patterns",
			rows: []string{"ID,Name,Email", "1,John,john@test.com", "2,Jane,jane@test.com"},
			want: true,
		},
		{
			name: "first row no numbers, data has numbers",
			rows: []string{"Product,Price,Quantity", "Apple,1.99,100", "Banana,0.99,200"},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isCSVHeader(tt.rows)
			if got != tt.want {
				t.Errorf("isCSVHeader() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTransformCSVIntoUnits(t *testing.T) {
	tests := []struct {
		name       string
		text       string
		maxTokens  int
		wantChunks int
		wantHeader string
	}{
		{
			name:       "small CSV fits in one chunk",
			text:       "Name,Age\nJohn,25\nJane,30",
			maxTokens:  100,
			wantChunks: 1,
			wantHeader: "Name,Age",
		},
		{
			name:       "CSV splits into multiple chunks with header preserved",
			text:       "Name,Age\nJohn,25\nJane,30\nBob,35\nAlice,28",
			maxTokens:  5,
			wantChunks: 4,
			wantHeader: "Name,Age",
		},
		{
			name:       "single row CSV treated as data",
			text:       "John,25,NYC",
			maxTokens:  100,
			wantChunks: 1,
			wantHeader: "",
		},
		{
			name:       "empty text",
			text:       "",
			maxTokens:  100,
			wantChunks: 0,
			wantHeader: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := transformCSVIntoUnits(tt.text, "test.csv", "cl100k_base", tt.maxTokens)
			if err != nil {
				t.Fatalf("transformCSVIntoUnits() error = %v", err)
			}

			if len(got) != tt.wantChunks {
				t.Errorf("transformCSVIntoUnits() returned %d chunks, want %d", len(got), tt.wantChunks)
			}

			if tt.wantHeader != "" && len(got) > 1 {
				for i, chunk := range got {
					if !strings.HasPrefix(chunk.text, tt.wantHeader) {
						t.Errorf("chunk[%d] should start with header %q, got %q", i, tt.wantHeader, chunk.text[:min(len(chunk.text), 20)])
					}
				}
			}
		})
	}
}

func TestGetUnitsFromTextCSV(t *testing.T) {
	text := "Name,Age,City\nJohn,25,NYC\nJane,30,LA"

	file := loader.GraphFile{
		ID:        "test.csv",
		FilePath:  "test.csv",
		FileType:  loader.GraphFileTypeCSV,
		MaxTokens: 100,
		Loader:    &mockLoader{text: text},
	}

	got, err := getUnitsFromText(context.Background(), file, "cl100k_base")
	if err != nil {
		t.Fatalf("getUnitsFromText() error = %v", err)
	}

	if len(got) != 1 {
		t.Errorf("getUnitsFromText() returned %d units, want 1", len(got))
	}

	if !strings.HasPrefix(got[0].text, "Name,Age,City") {
		t.Errorf("expected CSV output to start with header")
	}
}
