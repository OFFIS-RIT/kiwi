package graph

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"

	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/pkoukk/tiktoken-go"
)

type processUnit struct {
	id     string
	fileID string
	start  int
	end    int
	text   string
}

func isCSVHeader(rows []string) bool {
	if len(rows) < 2 {
		return false
	}

	firstRow := rows[0]
	firstFields := strings.Split(firstRow, ",")

	firstRowNumericCount := 0
	for _, field := range firstFields {
		field = strings.TrimSpace(field)
		field = strings.Trim(field, "\"")
		if _, err := strconv.ParseFloat(field, 64); err == nil {
			firstRowNumericCount++
		}
	}

	sampleSize := util.Min(5, len(rows)-1)
	dataNumericTotal := 0
	dataFieldTotal := 0

	for i := 1; i <= sampleSize; i++ {
		fields := strings.SplitSeq(rows[i], ",")
		for field := range fields {
			field = strings.TrimSpace(field)
			field = strings.Trim(field, "\"")
			dataFieldTotal++
			if _, err := strconv.ParseFloat(field, 64); err == nil {
				dataNumericTotal++
			}
		}
	}

	firstRowNumericRatio := float64(firstRowNumericCount) / float64(len(firstFields))
	dataNumericRatio := float64(0)
	if dataFieldTotal > 0 {
		dataNumericRatio = float64(dataNumericTotal) / float64(dataFieldTotal)
	}

	if firstRowNumericRatio < 0.3 && dataNumericRatio > firstRowNumericRatio+0.2 {
		return true
	}

	headerPatterns := []string{"id", "name", "date", "time", "type", "status",
		"description", "value", "amount", "count", "total", "email", "phone"}
	headerMatchCount := 0
	for _, field := range firstFields {
		fieldLower := strings.ToLower(strings.TrimSpace(strings.Trim(field, "\"")))
		for _, pattern := range headerPatterns {
			if strings.Contains(fieldLower, pattern) {
				headerMatchCount++
				break
			}
		}
	}

	if headerMatchCount >= 2 {
		return true
	}

	if firstRowNumericCount == 0 && dataNumericTotal > 0 {
		return true
	}

	return true
}

func transformCSVIntoUnits(
	text string,
	fileId string,
	encoder string,
	maxTokens int,
) ([]processUnit, error) {
	enc, err := tiktoken.GetEncoding(encoder)
	if err != nil {
		return nil, err
	}

	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}

	rows := strings.Split(text, "\n")
	if len(rows) == 0 {
		return nil, nil
	}

	hasHeader := isCSVHeader(rows)
	var headerRow string
	var dataRows []string

	if hasHeader && len(rows) > 1 {
		headerRow = rows[0]
		dataRows = rows[1:]
	} else {
		headerRow = ""
		dataRows = rows
	}

	var chunks []processUnit
	var currentRows []string
	currentTokens := 0

	flushChunk := func() error {
		if len(currentRows) == 0 {
			return nil
		}

		uID, err := gonanoid.New()
		if err != nil {
			return err
		}

		var chunkText strings.Builder
		if headerRow != "" {
			chunkText.WriteString(headerRow)
			chunkText.WriteString("\n")
		}
		chunkText.WriteString(strings.Join(currentRows, "\n"))

		unit := processUnit{
			id:     uID,
			fileID: fileId,
			start:  len(chunks),
			end:    len(chunks) + 1,
			text:   chunkText.String(),
		}
		chunks = append(chunks, unit)
		currentRows = nil
		currentTokens = 0
		return nil
	}

	for _, row := range dataRows {
		rowTokens := len(enc.Encode(row, nil, nil)) + 1

		if currentTokens+rowTokens > maxTokens && len(currentRows) > 0 {
			if err := flushChunk(); err != nil {
				return nil, err
			}
		}

		currentRows = append(currentRows, row)
		currentTokens += rowTokens
	}

	if err := flushChunk(); err != nil {
		return nil, err
	}

	return chunks, nil
}

func transformIntoUnits(
	text string,
	fileId string,
	encoder string,
	maxTokens int,
) ([]processUnit, error) {
	enc, err := tiktoken.GetEncoding(encoder)
	if err != nil {
		return nil, err
	}

	sentences := splitIntoSentences(text)
	if len(sentences) == 0 {
		return nil, nil
	}

	var chunks []processUnit
	chunkStart := -1
	chunkEnd := -1

	flushChunk := func() error {
		if chunkStart < 0 || chunkEnd <= chunkStart {
			return nil
		}
		uID, err := gonanoid.New()
		if err != nil {
			return err
		}

		var chunkText strings.Builder
		for i := chunkStart; i < chunkEnd; i++ {
			if i > chunkStart {
				chunkText.WriteString(" ")
			}
			chunkText.WriteString(sentences[i])
		}

		unit := processUnit{
			id:     uID,
			fileID: fileId,
			start:  chunkStart,
			end:    chunkEnd,
			text:   strings.TrimSpace(chunkText.String()),
		}
		chunks = append(chunks, unit)
		chunkStart = -1
		chunkEnd = -1
		return nil
	}

	for i := range sentences {
		if chunkStart < 0 {
			chunkStart = i
			chunkEnd = i + 1
			continue
		}

		var testText strings.Builder
		for j := chunkStart; j <= i; j++ {
			if j > chunkStart {
				testText.WriteString(" ")
			}
			testText.WriteString(sentences[j])
		}

		testTokens := len(enc.Encode(testText.String(), nil, nil))

		if testTokens <= maxTokens {
			chunkEnd = i + 1
		} else {
			if err := flushChunk(); err != nil {
				return nil, err
			}
			chunkStart = i
			chunkEnd = i + 1
		}
	}

	if err := flushChunk(); err != nil {
		return nil, err
	}

	return chunks, nil
}

func getUnitsFromText(
	ctx context.Context,
	file loader.GraphFile,
	encoder string,
) ([]processUnit, error) {
	textBytes, err := file.GetText(ctx)
	if err != nil {
		return nil, err
	}
	text := string(textBytes)
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}

	if file.FileType == loader.GraphFileTypeImage {
		uID, err := gonanoid.New()
		if err != nil {
			return nil, err
		}
		unit := processUnit{
			id:     uID,
			fileID: file.ID,
			start:  0,
			end:    1,
			text:   text,
		}
		return []processUnit{unit}, nil
	}

	if file.FileType == loader.GraphFileTypeCSV {
		return transformCSVIntoUnits(text, file.ID, encoder, file.MaxTokens)
	}

	return transformIntoUnits(text, file.ID, encoder, file.MaxTokens)
}

func splitIntoSentences(text string) []string {
	lines := strings.Split(text, "\n")
	var sentences []string
	var currentSentence strings.Builder

	tableDelimRe := regexp.MustCompile(`^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$`)

	isTableRow := func(line string) bool {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			return false
		}
		return strings.Contains(trimmed, "|")
	}

	inTable := false

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		if !inTable && isTableRow(line) && i+1 < len(lines) && tableDelimRe.MatchString(strings.TrimSpace(lines[i+1])) {
			if currentSentence.Len() > 0 {
				sentences = append(sentences, strings.TrimSpace(currentSentence.String()))
				currentSentence.Reset()
			}

			inTable = true
			currentSentence.WriteString(line)
			continue
		}

		if !inTable && isTableRow(line) {
			if currentSentence.Len() > 0 {
				sentences = append(sentences, strings.TrimSpace(currentSentence.String()))
				currentSentence.Reset()
			}

			sentences = append(sentences, trimmed)
			continue
		}

		if inTable {
			if trimmed == "" || !isTableRow(line) {
				inTable = false
				sentences = append(sentences, strings.TrimSpace(currentSentence.String()))
				currentSentence.Reset()

				if trimmed != "" {
					lineSentences := splitLineIntoSentences(trimmed)
					for _, sentence := range lineSentences {
						if currentSentence.Len() > 0 {
							currentSentence.WriteString(" ")
						}
						currentSentence.WriteString(sentence)

						if strings.HasSuffix(strings.TrimSpace(sentence), ".") ||
							strings.HasSuffix(strings.TrimSpace(sentence), "!") ||
							strings.HasSuffix(strings.TrimSpace(sentence), "?") {
							sentences = append(sentences, strings.TrimSpace(currentSentence.String()))
							currentSentence.Reset()
						}
					}
				}
			} else {
				currentSentence.WriteString("\n")
				currentSentence.WriteString(line)
			}
			continue
		}

		if trimmed == "" {
			if currentSentence.Len() > 0 {
				sentences = append(sentences, strings.TrimSpace(currentSentence.String()))
				currentSentence.Reset()
			}
		} else {
			lineSentences := splitLineIntoSentences(trimmed)
			for _, sentence := range lineSentences {
				if currentSentence.Len() > 0 {
					currentSentence.WriteString(" ")
				}
				currentSentence.WriteString(sentence)

				if strings.HasSuffix(strings.TrimSpace(sentence), ".") ||
					strings.HasSuffix(strings.TrimSpace(sentence), "!") ||
					strings.HasSuffix(strings.TrimSpace(sentence), "?") {
					sentences = append(sentences, strings.TrimSpace(currentSentence.String()))
					currentSentence.Reset()
				}
			}
		}
	}

	if currentSentence.Len() > 0 {
		sentences = append(sentences, strings.TrimSpace(currentSentence.String()))
	}

	var result []string
	for _, sentence := range sentences {
		if strings.TrimSpace(sentence) != "" {
			result = append(result, sentence)
		}
	}

	return result
}

func splitLineIntoSentences(line string) []string {
	var sentences []string
	var current strings.Builder

	for i := 0; i < len(line); i++ {
		current.WriteByte(line[i])

		if line[i] == '.' || line[i] == '!' || line[i] == '?' {
			isNumericListing := false

			if i > 0 && unicode.IsDigit(rune(line[i-1])) {
				if i+1 < len(line) && line[i+1] == ' ' {
					isNumericListing = true
				}
			}

			if isNumericListing {
				continue
			}
			j := i + 1
			for j < len(line) && (line[j] == '.' || line[j] == '!' || line[j] == '?') {
				current.WriteByte(line[j])
				j++
			}

			for j < len(line) && (line[j] == '"' || line[j] == '\'' || line[j] == ')' ||
				line[j] == ']' || line[j] == '}') {
				current.WriteByte(line[j])
				j++
			}

			sentence := strings.TrimSpace(current.String())
			if sentence != "" {
				sentences = append(sentences, sentence)
			}
			current.Reset()
			i = j - 1
		}
	}

	remaining := strings.TrimSpace(current.String())
	if remaining != "" {
		sentences = append(sentences, remaining)
	}

	return sentences
}
