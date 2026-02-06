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

type unitSegmentKind int

const (
	segmentText unitSegmentKind = iota
	segmentTableRow
)

type unitSegment struct {
	text        string
	kind        unitSegmentKind
	tableHeader string
	tableID     int
}

type unitRequest struct {
	text    string
	file    loader.GraphFile
	encoder string
}

type unitBuilder interface {
	buildUnits(req unitRequest) ([]processUnit, error)
}

type textUnitBuilder struct{}

type csvUnitBuilder struct{}

type singleUnitBuilder struct{}

func (textUnitBuilder) buildUnits(req unitRequest) ([]processUnit, error) {
	return transformIntoUnits(req.text, req.file.ID, req.encoder, req.file.MaxTokens)
}

func (csvUnitBuilder) buildUnits(req unitRequest) ([]processUnit, error) {
	return transformCSVIntoUnits(req.text, req.file.ID, req.encoder, req.file.MaxTokens)
}

func (singleUnitBuilder) buildUnits(req unitRequest) ([]processUnit, error) {
	uID, err := gonanoid.New()
	if err != nil {
		return nil, err
	}
	unit := processUnit{
		id:     uID,
		fileID: req.file.ID,
		start:  0,
		end:    1,
		text:   req.text,
	}
	return []processUnit{unit}, nil
}

var defaultUnitBuilder unitBuilder = textUnitBuilder{}

var markdownTableDelimiterPattern = regexp.MustCompile(`^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$`)

var commonSentenceAbbreviations = map[string]struct{}{
	"bsp.":  {},
	"bzw.":  {},
	"ca.":   {},
	"dipl.": {},
	"dr.":   {},
	"etc.":  {},
	"evtl.": {},
	"geb.":  {},
	"ing.":  {},
	"mr.":   {},
	"mrs.":  {},
	"ms.":   {},
	"nr.":   {},
	"prof.": {},
	"str.":  {},
	"tel.":  {},
	"usw.":  {},
	"vgl.":  {},
}

var unitBuildersByType = map[loader.GraphFileType]unitBuilder{
	loader.GraphFileTypeCSV:   csvUnitBuilder{},
	loader.GraphFileTypeImage: singleUnitBuilder{},
	loader.GraphFileTypeFile:  singleUnitBuilder{},
}

func unitBuilderForFileType(fileType loader.GraphFileType) unitBuilder {
	if builder, ok := unitBuildersByType[fileType]; ok {
		return builder
	}
	return defaultUnitBuilder
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

	segments := splitIntoSegments(text)
	if len(segments) == 0 {
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

		chunkText := buildChunkText(segments, chunkStart, chunkEnd)

		unit := processUnit{
			id:     uID,
			fileID: fileId,
			start:  chunkStart,
			end:    chunkEnd,
			text:   strings.TrimSpace(chunkText),
		}
		chunks = append(chunks, unit)
		chunkStart = -1
		chunkEnd = -1
		return nil
	}

	for i := range segments {
		if chunkStart < 0 {
			chunkStart = i
			chunkEnd = i + 1
			continue
		}

		testText := buildChunkText(segments, chunkStart, i+1)
		testTokens := len(enc.Encode(testText, nil, nil))

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

func buildChunkText(segments []unitSegment, start, end int) string {
	var chunkText strings.Builder
	currentTableID := -1
	lastKind := segmentText
	hasContent := false

	for i := start; i < end; i++ {
		segment := segments[i]

		if segment.kind == segmentTableRow && segment.tableHeader != "" && segment.tableID != currentTableID {
			if hasContent {
				chunkText.WriteString("\n")
			}
			chunkText.WriteString(segment.tableHeader)
			chunkText.WriteString("\n")
			chunkText.WriteString(segment.text)
			hasContent = true
			currentTableID = segment.tableID
			lastKind = segmentTableRow
			continue
		}

		if hasContent {
			if segment.kind == segmentTableRow {
				chunkText.WriteString("\n")
			} else if lastKind == segmentTableRow {
				chunkText.WriteString("\n")
			} else {
				chunkText.WriteString(" ")
			}
		}

		chunkText.WriteString(segment.text)
		hasContent = true

		if segment.kind == segmentTableRow {
			currentTableID = segment.tableID
			lastKind = segmentTableRow
		} else {
			currentTableID = -1
			lastKind = segmentText
		}
	}

	return chunkText.String()
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

	req := unitRequest{
		text:    text,
		file:    file,
		encoder: encoder,
	}
	return unitBuilderForFileType(file.FileType).buildUnits(req)
}

func splitIntoSegments(text string) []unitSegment {
	lines := strings.Split(text, "\n")
	var segments []unitSegment
	var currentSentence strings.Builder

	appendSentence := func() {
		if currentSentence.Len() == 0 {
			return
		}
		segments = append(segments, unitSegment{
			text: strings.TrimSpace(currentSentence.String()),
			kind: segmentText,
		})
		currentSentence.Reset()
	}

	isTableRow := func(line string) bool {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			return false
		}
		return strings.Contains(trimmed, "|")
	}

	inTable := false
	tableID := 0
	tableHeader := ""
	tableHasRows := false

	for i := 0; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r")
		trimmed := strings.TrimSpace(line)

		if !inTable && isTableRow(line) && i+1 < len(lines) && markdownTableDelimiterPattern.MatchString(strings.TrimSpace(lines[i+1])) {
			appendSentence()
			inTable = true
			tableID++
			tableHeader = line + "\n" + strings.TrimRight(lines[i+1], "\r")
			tableHasRows = false
			i++
			continue
		}

		if inTable {
			if trimmed == "" || !isTableRow(line) {
				if !tableHasRows && tableHeader != "" {
					segments = append(segments, unitSegment{
						text: tableHeader,
						kind: segmentText,
					})
				}
				inTable = false
				tableHeader = ""
				tableHasRows = false
				if trimmed == "" {
					appendSentence()
					continue
				}
				lineSentences := splitLineIntoSentences(trimmed)
				for _, sentence := range lineSentences {
					if currentSentence.Len() > 0 {
						currentSentence.WriteString(" ")
					}
					currentSentence.WriteString(sentence)

					if endsWithSentenceTerminator(sentence) {
						appendSentence()
					}
				}
				continue
			}

			segments = append(segments, unitSegment{
				text:        line,
				kind:        segmentTableRow,
				tableHeader: tableHeader,
				tableID:     tableID,
			})
			tableHasRows = true
			continue
		}

		if !inTable && isTableRow(line) {
			appendSentence()
			if trimmed != "" {
				segments = append(segments, unitSegment{
					text: trimmed,
					kind: segmentText,
				})
			}
			continue
		}

		if trimmed == "" {
			appendSentence()
			continue
		}

		lineSentences := splitLineIntoSentences(trimmed)
		for _, sentence := range lineSentences {
			if currentSentence.Len() > 0 {
				currentSentence.WriteString(" ")
			}
			currentSentence.WriteString(sentence)

			if endsWithSentenceTerminator(sentence) {
				appendSentence()
			}
		}
	}

	if inTable && !tableHasRows && tableHeader != "" {
		segments = append(segments, unitSegment{
			text: tableHeader,
			kind: segmentText,
		})
	}

	appendSentence()

	var result []unitSegment
	for _, segment := range segments {
		if strings.TrimSpace(segment.text) != "" {
			result = append(result, segment)
		}
	}

	return result
}

func splitIntoSentences(text string) []string {
	lines := strings.Split(text, "\n")
	var sentences []string
	var currentSentence strings.Builder

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

		if !inTable && isTableRow(line) && i+1 < len(lines) && markdownTableDelimiterPattern.MatchString(strings.TrimSpace(lines[i+1])) {
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

						if endsWithSentenceTerminator(sentence) {
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

				if endsWithSentenceTerminator(sentence) {
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
	runes := []rune(line)
	if len(runes) == 0 {
		return nil
	}

	sentences := make([]string, 0)
	start := 0

	flush := func(end int) {
		if end <= start {
			return
		}
		sentence := strings.TrimSpace(string(runes[start:end]))
		if sentence != "" {
			sentences = append(sentences, sentence)
		}
		start = end
	}

	for i := 0; i < len(runes); i++ {
		if !isSentenceBoundaryAtRune(runes, i) {
			continue
		}

		end := i + 1
		for end < len(runes) && (runes[end] == '.' || runes[end] == '!' || runes[end] == '?') {
			end++
		}
		for end < len(runes) && isSentenceClosingRune(runes[end]) {
			end++
		}

		flush(end)
		i = end - 1
	}

	flush(len(runes))

	return sentences
}

func endsWithSentenceTerminator(sentence string) bool {
	trimmed := strings.TrimSpace(sentence)
	if trimmed == "" {
		return false
	}

	runes := []rune(trimmed)
	idx := len(runes) - 1
	for idx >= 0 && isSentenceClosingRune(runes[idx]) {
		idx--
	}
	if idx < 0 {
		return false
	}

	return runes[idx] == '.' || runes[idx] == '!' || runes[idx] == '?'
}

func isSentenceBoundaryAtRune(runes []rune, idx int) bool {
	if idx < 0 || idx >= len(runes) {
		return false
	}

	switch runes[idx] {
	case '!', '?':
		return true
	case '.':
		if isDateOrDecimalDot(runes, idx) {
			return false
		}
		if isNumericListingDot(runes, idx) {
			return false
		}
		if isAbbreviationDot(runes, idx) {
			return false
		}
		return true
	default:
		return false
	}
}

func isDateOrDecimalDot(runes []rune, dotIndex int) bool {
	prev := previousNonSpaceRuneIndex(runes, dotIndex-1)
	next := nextNonSpaceRuneIndex(runes, dotIndex+1)

	if prev >= 0 && next >= 0 && unicode.IsDigit(runes[prev]) && unicode.IsDigit(runes[next]) {
		return true
	}

	if prev < 0 || !unicode.IsDigit(runes[prev]) {
		return false
	}

	numberStart := prev
	for numberStart >= 0 && unicode.IsDigit(runes[numberStart]) {
		numberStart--
	}

	prevDot := previousNonSpaceRuneIndex(runes, numberStart)
	prevDigit := previousNonSpaceRuneIndex(runes, prevDot-1)
	if prevDot >= 0 && runes[prevDot] == '.' && prevDigit >= 0 && unicode.IsDigit(runes[prevDigit]) {
		return true
	}

	return false
}

func isNumericListingDot(runes []rune, dotIndex int) bool {
	prev := previousNonSpaceRuneIndex(runes, dotIndex-1)
	next := nextNonSpaceRuneIndex(runes, dotIndex+1)
	if prev < 0 || next < 0 {
		return false
	}
	if !unicode.IsDigit(runes[prev]) || !unicode.IsLetter(runes[next]) {
		return false
	}

	if dotIndex+1 < len(runes) && unicode.IsSpace(runes[dotIndex+1]) && unicode.IsUpper(runes[next]) {
		return true
	}

	numberStart := prev
	for numberStart >= 0 && unicode.IsDigit(runes[numberStart]) {
		numberStart--
	}

	beforeNumber := previousNonSpaceRuneIndex(runes, numberStart)
	if beforeNumber < 0 {
		return true
	}

	switch runes[beforeNumber] {
	case '.', ':', ';', '(', '[', '{':
		return true
	default:
		return false
	}
}

func isAbbreviationDot(runes []rune, dotIndex int) bool {
	prev := previousNonSpaceRuneIndex(runes, dotIndex-1)
	if prev < 0 || !unicode.IsLetter(runes[prev]) {
		return false
	}

	wordStart := prev
	for wordStart >= 0 && (unicode.IsLetter(runes[wordStart]) || runes[wordStart] == '-') {
		wordStart--
	}

	word := strings.ToLower(strings.TrimSpace(string(runes[wordStart+1 : prev+1])))
	if word == "" {
		return false
	}

	if _, ok := commonSentenceAbbreviations[word+"."]; ok {
		return true
	}

	wordRunes := []rune(word)
	if len(wordRunes) != 1 {
		return false
	}

	next := nextNonSpaceRuneIndex(runes, dotIndex+1)
	if next >= 0 && unicode.IsLetter(runes[next]) {
		nextDot := nextNonSpaceRuneIndex(runes, next+1)
		if nextDot >= 0 && runes[nextDot] == '.' {
			return true
		}
	}

	prevDot := previousNonSpaceRuneIndex(runes, wordStart)
	if prevDot < 0 || runes[prevDot] != '.' {
		return false
	}

	prevLetter := previousNonSpaceRuneIndex(runes, prevDot-1)
	if prevLetter < 0 || !unicode.IsLetter(runes[prevLetter]) {
		return false
	}

	prevWordStart := prevLetter
	for prevWordStart >= 0 && unicode.IsLetter(runes[prevWordStart]) {
		prevWordStart--
	}

	if prevLetter-prevWordStart != 1 {
		return false
	}

	nextAfterDot := nextNonSpaceRuneIndex(runes, dotIndex+1)
	if nextAfterDot >= 0 &&
		unicode.IsLower(runes[nextAfterDot]) &&
		unicode.IsUpper(runes[prev]) &&
		unicode.IsUpper(runes[prevLetter]) {
		return false
	}

	return true
}

func previousNonSpaceRuneIndex(runes []rune, start int) int {
	for i := start; i >= 0; i-- {
		if !unicode.IsSpace(runes[i]) {
			return i
		}
	}
	return -1
}

func nextNonSpaceRuneIndex(runes []rune, start int) int {
	for i := start; i < len(runes); i++ {
		if !unicode.IsSpace(runes[i]) {
			return i
		}
	}
	return -1
}

func isSentenceClosingRune(r rune) bool {
	switch r {
	case '"', '\'', ')', ']', '}', '»', '“', '”':
		return true
	default:
		return false
	}
}
