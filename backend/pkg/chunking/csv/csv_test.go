package csv

import (
	"context"
	"strings"
	"testing"
)

func TestCSVChunker_Chunk_EmptyInput(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 100,
		Encoder:      "cl100k_base",
	})

	chunks, err := chunker.Chunk(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chunks != nil {
		t.Errorf("expected nil, got %v", chunks)
	}
}

func TestCSVChunker_Chunk_WhitespaceOnly(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 100,
		Encoder:      "cl100k_base",
	})

	chunks, err := chunker.Chunk(context.Background(), "   \n\n  ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if chunks != nil {
		t.Errorf("expected nil, got %v", chunks)
	}
}

func TestCSVChunker_Chunk_SingleRow(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 100,
		Encoder:      "cl100k_base",
	})

	chunks, err := chunker.Chunk(context.Background(), "name,age,email")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	if chunks[0].Text != "name,age,email" {
		t.Errorf("unexpected text: %q", chunks[0].Text)
	}
	if chunks[0].ID == "" {
		t.Error("chunk ID should not be empty")
	}
}

func TestCSVChunker_Chunk_HeaderPlusOneRow(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 100,
		Encoder:      "cl100k_base",
	})

	input := "name,age\nAlice,30"
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	if !strings.HasPrefix(chunks[0].Text, "name,age\n") {
		t.Errorf("chunk should start with header, got: %q", chunks[0].Text)
	}
	if !strings.Contains(chunks[0].Text, "Alice,30") {
		t.Errorf("chunk should contain data row, got: %q", chunks[0].Text)
	}
}

func TestCSVChunker_Chunk_MultipleRowsFitInOneChunk(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 1000,
		Encoder:      "cl100k_base",
	})

	input := "name,age\nAlice,30\nBob,25\nCharlie,35"
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	if chunks[0].Text != "name,age\nAlice,30\nBob,25\nCharlie,35" {
		t.Errorf("unexpected text: %q", chunks[0].Text)
	}
}

func TestCSVChunker_Chunk_SplitsIntoMultipleChunks(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 10,
		Encoder:      "cl100k_base",
	})

	var rows []string
	rows = append(rows, "name,age,email,city")
	for i := 0; i < 20; i++ {
		rows = append(rows, "Alice,30,alice@example.com,Wonderland")
	}
	input := strings.Join(rows, "\n")

	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) <= 1 {
		t.Errorf("expected multiple chunks, got %d", len(chunks))
	}

	for i, c := range chunks {
		if !strings.HasPrefix(c.Text, "name,age,email,city\n") {
			t.Errorf("chunk %d should start with header, got: %q", i, c.Text)
		}
	}

	ids := make(map[string]bool)
	for _, c := range chunks {
		if ids[c.ID] {
			t.Errorf("duplicate chunk ID: %s", c.ID)
		}
		ids[c.ID] = true
	}
}

func TestCSVChunker_Chunk_EachChunkHasHeader(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 5,
		Encoder:      "cl100k_base",
	})

	input := "id,value\n1,aaa\n2,bbb\n3,ccc\n4,ddd\n5,eee\n6,fff\n7,ggg\n8,hhh\n9,iii\n10,jjj"
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for i, c := range chunks {
		lines := strings.Split(c.Text, "\n")
		if lines[0] != "id,value" {
			t.Errorf("chunk %d first line should be header 'id,value', got %q", i, lines[0])
		}
		if len(lines) < 2 {
			t.Errorf("chunk %d should have at least header + 1 data row", i)
		}
	}
}

func TestCSVChunker_Chunk_AllDataRowsPreserved(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 10,
		Encoder:      "cl100k_base",
	})

	dataRows := []string{"1,Alice", "2,Bob", "3,Charlie", "4,Dave", "5,Eve"}
	input := "id,name\n" + strings.Join(dataRows, "\n")

	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	allDataRows := make(map[string]bool)
	for _, c := range chunks {
		lines := strings.Split(c.Text, "\n")
		for _, line := range lines[1:] {
			allDataRows[line] = true
		}
	}

	for _, row := range dataRows {
		if !allDataRows[row] {
			t.Errorf("data row %q missing from chunks", row)
		}
	}
}

func TestCSVChunker_Chunk_InvalidEncoder(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 100,
		Encoder:      "invalid_encoder",
	})

	_, err := chunker.Chunk(context.Background(), "name,age\nAlice,30")
	if err == nil {
		t.Error("expected error for invalid encoder")
	}
}

func TestCSVChunker_Chunk_LargeMaxChunkSize(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 100000,
		Encoder:      "cl100k_base",
	})

	var rows []string
	rows = append(rows, "col1,col2")
	for i := 0; i < 100; i++ {
		rows = append(rows, "data1,data2")
	}
	input := strings.Join(rows, "\n")

	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Errorf("expected 1 chunk for large max size, got %d", len(chunks))
	}
}

func TestCSVChunker_Chunk_SingleDataRowPerChunk(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 1,
		Encoder:      "cl100k_base",
	})

	input := "id,value\n1,row1\n2,row2\n3,row3"
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 3 {
		t.Errorf("expected 3 chunks (one per row), got %d", len(chunks))
	}
	for i, c := range chunks {
		lines := strings.Split(c.Text, "\n")
		if lines[0] != "id,value" {
			t.Errorf("chunk %d missing header", i)
		}
	}
}

func TestCSVChunker_Chunk_TrailingNewline(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 100,
		Encoder:      "cl100k_base",
	})

	input := "name,age\nAlice,30\nBob,25\n"
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	if strings.HasSuffix(chunks[0].Text, "\n") {
		t.Error("chunk should not end with newline from trailing input newline")
	}
}

func TestCSVChunker_Chunk_LeadingWhitespace(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 100,
		Encoder:      "cl100k_base",
	})

	input := "  \n  name,age\nAlice,30"
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	lines := strings.Split(chunks[0].Text, "\n")
	if lines[0] != "name,age" {
		t.Errorf("expected header 'name,age', got %q", lines[0])
	}
}

func TestNewCSVChunker(t *testing.T) {
	params := NewCSVChunkerParams{
		MaxChunkSize: 42,
		Encoder:      "cl100k_base",
	}
	chunker := NewCSVChunker(params)
	if chunker.maxChunkSize != 42 {
		t.Errorf("maxChunkSize = %d, want 42", chunker.maxChunkSize)
	}
	if chunker.encoder != "cl100k_base" {
		t.Errorf("encoder = %q, want %q", chunker.encoder, "cl100k_base")
	}
}

func TestIsCSVHeader(t *testing.T) {
	tests := []struct {
		name string
		rows []string
		want bool
	}{
		{
			name: "less than 2 rows",
			rows: []string{"name,age"},
			want: false,
		},
		{
			name: "empty rows",
			rows: nil,
			want: false,
		},
		{
			name: "single row",
			rows: []string{"a"},
			want: false,
		},
		{
			name: "header with known patterns",
			rows: []string{"id,name,email", "1,Alice,alice@test.com", "2,Bob,bob@test.com"},
			want: true,
		},
		{
			name: "header with description and status",
			rows: []string{"description,status,date", "foo,active,2024-01-01", "bar,inactive,2024-02-01"},
			want: true,
		},
		{
			name: "first row text data rows numeric",
			rows: []string{"name,score", "1,100", "2,200"},
			want: true,
		},
		{
			name: "first row no numbers data rows have numbers",
			rows: []string{"a,b,c", "1,2,3", "4,5,6"},
			want: true,
		},
		{
			name: "numeric ratio difference triggers header detection",
			rows: []string{"label,category", "10,20", "30,40", "50,60"},
			want: true,
		},
		{
			name: "all text rows",
			rows: []string{"foo,bar", "baz,qux", "hello,world"},
			want: true,
		},
		{
			name: "two rows minimum",
			rows: []string{"id,name", "1,Alice"},
			want: true,
		},
		{
			name: "quoted fields",
			rows: []string{`"id","name","email"`, `"1","Alice","alice@test.com"`},
			want: true,
		},
		{
			name: "header patterns type and value",
			rows: []string{"type,value,count", "widget,10,5"},
			want: true,
		},
		{
			name: "header with amount and total",
			rows: []string{"amount,total,phone", "100,200,555-1234"},
			want: true,
		},
		{
			name: "header with time",
			rows: []string{"time,event", "10:00,start"},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsCSVHeader(tt.rows)
			if got != tt.want {
				t.Errorf("IsCSVHeader(%v) = %v, want %v", tt.rows, got, tt.want)
			}
		})
	}
}

func TestIsCSVHeader_AllNumericRows(t *testing.T) {
	rows := []string{"1,2,3", "4,5,6", "7,8,9"}
	got := IsCSVHeader(rows)
	if got {
		t.Error("expected false for all-numeric rows (no distinguishable header)")
	}
}

func TestIsCSVHeader_SampleSizeLimitedToFiveRows(t *testing.T) {
	rows := []string{"id,name"}
	for i := 0; i < 20; i++ {
		rows = append(rows, "1,Alice")
	}
	got := IsCSVHeader(rows)
	if !got {
		t.Error("expected true for header with known pattern 'id,name'")
	}
}

func TestIsCSVHeader_NumericFirstRow_NumericDataRows(t *testing.T) {
	rows := []string{"1,label", "2,100", "3,200"}
	got := IsCSVHeader(rows)
	if !got {
		t.Error("expected true")
	}
}

func TestCSVChunker_Chunk_NoHeaderDoesNotDuplicateFirstRow(t *testing.T) {
	chunker := NewCSVChunker(NewCSVChunkerParams{
		MaxChunkSize: 1,
		Encoder:      "cl100k_base",
	})

	input := "1,Alice\n2,Bob\n3,Charlie"
	chunks, err := chunker.Chunk(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks (one per row), got %d", len(chunks))
	}

	seenRows := make(map[string]int)
	for i, c := range chunks {
		lines := strings.Split(c.Text, "\n")
		if len(lines) != 1 {
			t.Fatalf("chunk %d should only contain one row when no header exists, got %q", i, c.Text)
		}
		seenRows[lines[0]]++
	}

	expectedRows := []string{"1,Alice", "2,Bob", "3,Charlie"}
	for _, row := range expectedRows {
		if seenRows[row] != 1 {
			t.Errorf("expected row %q exactly once, got %d", row, seenRows[row])
		}
	}
}
