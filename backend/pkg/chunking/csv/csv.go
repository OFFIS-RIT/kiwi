package csv

import (
	"context"
	"strconv"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/chunking"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"
	"github.com/pkoukk/tiktoken-go"
)

type CSVChunker struct {
	maxChunkSize int
	encoder      string
}

type NewCSVChunkerParams struct {
	MaxChunkSize int
	Encoder      string
}

func NewCSVChunker(params NewCSVChunkerParams) *CSVChunker {
	return &CSVChunker{
		maxChunkSize: params.MaxChunkSize,
		encoder:      params.Encoder,
	}
}

func (c *CSVChunker) Chunk(_ context.Context, input string) ([]chunking.Chunk, error) {
	enc, err := tiktoken.GetEncoding(c.encoder)
	if err != nil {
		return nil, err
	}

	text := strings.TrimSpace(input)
	if text == "" {
		return nil, nil
	}

	rows := strings.Split(text, "\n")
	if len(rows) == 0 {
		return nil, nil
	}

	hasHeader := IsCSVHeader(rows)

	// Single row: return as-is (header only, no data to split).
	if len(rows) == 1 {
		return []chunking.Chunk{
			{
				ID:   ids.New(),
				Text: rows[0],
			},
		}, nil
	}

	dataRows := rows
	headerRow := ""
	if hasHeader {
		headerRow = rows[0]
		dataRows = rows[1:]
	}

	var chunks []string
	var currentRows []string
	currentTokens := 0

	flushChunk := func() {
		if len(currentRows) == 0 {
			return
		}

		var chunkText strings.Builder
		if hasHeader {
			chunkText.WriteString(headerRow)
			chunkText.WriteString("\n")
		}
		chunkText.WriteString(strings.Join(currentRows, "\n"))

		chunks = append(chunks, chunkText.String())
		currentRows = nil
		currentTokens = 0
	}

	for _, row := range dataRows {
		rowTokens := len(enc.Encode(row, nil, nil)) + 1

		if currentTokens+rowTokens > c.maxChunkSize && len(currentRows) > 0 {
			flushChunk()
		}

		currentRows = append(currentRows, row)
		currentTokens += rowTokens
	}

	flushChunk()

	result := make([]chunking.Chunk, len(chunks))
	for i := range chunks {
		result[i] = chunking.Chunk{
			ID:   ids.New(),
			Text: chunks[i],
		}
	}

	return result, nil
}

func IsCSVHeader(rows []string) bool {
	if len(rows) < 2 {
		return false
	}

	firstFields := cleanFields(rows[0])
	numCols := len(firstFields)
	if numCols == 0 {
		return false
	}

	sampleSize := min(5, len(rows)-1)

	// Count numeric fields in the first row.
	firstRowNumeric := 0
	for _, f := range firstFields {
		if isNumeric(f) {
			firstRowNumeric++
		}
	}

	// Analyse data rows: count numeric values per column.
	colNumeric := make([]int, numCols)
	dataNumericTotal := 0
	dataFieldTotal := 0

	for i := 1; i <= sampleSize; i++ {
		fields := cleanFields(rows[i])
		for j := 0; j < min(numCols, len(fields)); j++ {
			dataFieldTotal++
			if isNumeric(fields[j]) {
				colNumeric[j]++
				dataNumericTotal++
			}
		}
	}

	// Heuristic 1: First row is entirely non-numeric but data contains numbers.
	if firstRowNumeric == 0 && dataNumericTotal > 0 {
		return true
	}

	// Heuristic 2: First row has a significantly lower numeric ratio than data rows.
	firstRowNumericRatio := float64(firstRowNumeric) / float64(numCols)
	dataNumericRatio := float64(0)
	if dataFieldTotal > 0 {
		dataNumericRatio = float64(dataNumericTotal) / float64(dataFieldTotal)
	}
	if firstRowNumericRatio < 0.3 && dataNumericRatio > firstRowNumericRatio+0.2 {
		return true
	}

	// Heuristic 3: Per-column type mismatch. If a column is consistently numeric
	// across all sampled data rows but the first-row value is not numeric, the
	// first row is likely a label for that column.
	for j := 0; j < numCols; j++ {
		if colNumeric[j] == sampleSize && !isNumeric(firstFields[j]) {
			return true
		}
	}

	// Heuristic 4: For an all-text first row, check whether any of its values
	// appear in the same column of the data rows. Header labels are unique
	// descriptors and should not repeat as data values.
	if firstRowNumeric == 0 && numCols > 1 {
		matchesInData := 0
		nonEmpty := 0
		for j, headerVal := range firstFields {
			if headerVal == "" {
				continue
			}
			nonEmpty++
			for i := 1; i <= sampleSize; i++ {
				fields := cleanFields(rows[i])
				if j < len(fields) && strings.EqualFold(fields[j], headerVal) {
					matchesInData++
					break
				}
			}
		}
		if nonEmpty > 0 && matchesInData == 0 {
			return true
		}
	}

	return false
}

// cleanFields splits a CSV row by comma and trims whitespace and quotes from each field.
func cleanFields(row string) []string {
	fields := strings.Split(row, ",")
	for i, f := range fields {
		f = strings.TrimSpace(f)
		f = strings.Trim(f, "\"")
		fields[i] = f
	}
	return fields
}

// isNumeric reports whether s can be parsed as a floating-point number.
func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	_, err := strconv.ParseFloat(s, 64)
	return err == nil
}
