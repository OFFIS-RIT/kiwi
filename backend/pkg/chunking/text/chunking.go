package text

import (
	"math"
	"regexp"
	"strings"
	"unicode"

	"github.com/pkoukk/tiktoken-go"
)

type segmentKind int

const (
	segmentText segmentKind = iota
	segmentTableRow
)

type segment struct {
	text        string
	kind        segmentKind
	tableHeader string
	tableID     int
}

var markdownTableDelimiterPattern = regexp.MustCompile(`^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$`)

var markdownHeadingPattern = regexp.MustCompile(`^\s{0,3}#{1,6}\s*\S+`)

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

type semanticSplitLevel int

const (
	semanticSplitDoubleEmpty semanticSplitLevel = iota
	semanticSplitMarkdownHeading
	semanticSplitSentence
)

type tokenCounter struct {
	enc   *tiktoken.Tiktoken
	cache map[string]int
}

func newTokenCounter(enc *tiktoken.Tiktoken) *tokenCounter {
	return &tokenCounter{
		enc:   enc,
		cache: make(map[string]int),
	}
}

func (c *tokenCounter) count(text string) int {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}

	if tokens, ok := c.cache[text]; ok {
		return tokens
	}

	tokens := len(c.enc.Encode(text, nil, nil))
	c.cache[text] = tokens
	return tokens
}

func chunkTextRecursively(
	text string,
	counter *tokenCounter,
	maxTokens int,
	level semanticSplitLevel,
) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	if maxTokens <= 0 {
		return chunkBySentenceOrTable(text, counter, maxTokens)
	}

	if counter.count(text) <= maxTokens {
		return []string{text}
	}

	if level >= semanticSplitSentence {
		return chunkBySentenceOrTable(text, counter, maxTokens)
	}

	parts := splitBySemanticLevel(text, level)
	if len(parts) <= 1 {
		return chunkTextRecursively(text, counter, maxTokens, level+1)
	}

	result := make([]string, 0, len(parts))
	current := ""

	flushCurrent := func() {
		current = strings.TrimSpace(current)
		if current != "" {
			result = append(result, current)
		}
		current = ""
	}

	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		var subChunks []string
		if counter.count(part) > maxTokens {
			subChunks = chunkTextRecursively(part, counter, maxTokens, level+1)
		} else {
			subChunks = []string{part}
		}

		for _, subChunk := range subChunks {
			subChunk = strings.TrimSpace(subChunk)
			if subChunk == "" {
				continue
			}

			if current == "" {
				current = subChunk
				continue
			}

			candidate := joinChunkParts(current, subChunk)
			if counter.count(candidate) <= maxTokens {
				current = candidate
				continue
			}

			flushCurrent()
			current = subChunk
		}
	}

	flushCurrent()

	if len(result) == 0 {
		return chunkTextRecursively(text, counter, maxTokens, level+1)
	}

	return result
}

func splitBySemanticLevel(text string, level semanticSplitLevel) []string {
	switch level {
	case semanticSplitDoubleEmpty:
		return splitByDoubleEmptyLines(text)
	case semanticSplitMarkdownHeading:
		return splitByMarkdownHeadings(text)
	default:
		return []string{text}
	}
}

func chunkBySentenceOrTable(text string, counter *tokenCounter, maxTokens int) []string {
	segments := splitIntoSegments(text)
	if len(segments) == 0 {
		return nil
	}

	if maxTokens <= 0 {
		chunks := make([]string, 0, len(segments))
		for i := range segments {
			chunkText := strings.TrimSpace(buildChunkText(segments, i, i+1))
			if chunkText != "" {
				chunks = append(chunks, chunkText)
			}
		}
		return chunks
	}

	var chunks []string
	chunkStart := -1
	chunkEnd := -1

	flushChunk := func() {
		if chunkStart < 0 || chunkEnd <= chunkStart {
			return
		}
		chunkText := strings.TrimSpace(buildChunkText(segments, chunkStart, chunkEnd))
		if chunkText != "" {
			chunks = append(chunks, chunkText)
		}
		chunkStart = -1
		chunkEnd = -1
	}

	for i := range segments {
		if chunkStart < 0 {
			chunkStart = i
			chunkEnd = i + 1
			continue
		}

		testText := buildChunkText(segments, chunkStart, i+1)
		if counter.count(testText) <= maxTokens {
			chunkEnd = i + 1
			continue
		}

		flushChunk()
		chunkStart = i
		chunkEnd = i + 1
	}

	flushChunk()

	return chunks
}

func mergeTinyChunks(chunks []string, counter *tokenCounter, maxTokens int) []string {
	if len(chunks) <= 1 || maxTokens <= 0 {
		return chunks
	}

	minTokens := max(int(math.Ceil(float64(maxTokens)*0.05)), 1)

	for i := 0; i < len(chunks); {
		chunks[i] = strings.TrimSpace(chunks[i])
		if chunks[i] == "" {
			chunks = append(chunks[:i], chunks[i+1:]...)
			continue
		}

		if counter.count(chunks[i]) > minTokens || len(chunks) == 1 {
			i++
			continue
		}

		if i == 0 {
			chunks[1] = joinChunkParts(chunks[0], chunks[1])
			chunks = append(chunks[:0], chunks[1:]...)
			continue
		}

		chunks[i-1] = joinChunkParts(chunks[i-1], chunks[i])
		chunks = append(chunks[:i], chunks[i+1:]...)
		i--
		if i < 0 {
			i = 0
		}
	}

	return chunks
}

func joinChunkParts(left, right string) string {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)

	if left == "" {
		return right
	}
	if right == "" {
		return left
	}

	return left + "\n\n" + right
}

func splitByDoubleEmptyLines(text string) []string {
	lines := strings.Split(text, "\n")
	parts := make([]string, 0)
	current := make([]string, 0)
	emptyRun := 0

	flushCurrent := func() {
		if len(current) == 0 {
			return
		}
		part := strings.TrimSpace(strings.Join(current, "\n"))
		if part != "" {
			parts = append(parts, part)
		}
		current = current[:0]
	}

	for _, rawLine := range lines {
		line := strings.TrimRight(rawLine, "\r")
		if isEmptyLine(line) {
			emptyRun++
			if emptyRun >= 2 {
				flushCurrent()
			}
			continue
		}

		if emptyRun == 1 {
			current = append(current, "")
		}

		emptyRun = 0
		current = append(current, line)
	}

	flushCurrent()

	if len(parts) == 0 {
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			return nil
		}
		return []string{trimmed}
	}

	return parts
}

func splitByMarkdownHeadings(text string) []string {
	lines := strings.Split(text, "\n")
	parts := make([]string, 0)
	current := make([]string, 0)
	hasHeading := false

	flushCurrent := func() {
		if len(current) == 0 {
			return
		}
		part := strings.TrimSpace(strings.Join(current, "\n"))
		if part != "" {
			parts = append(parts, part)
		}
		current = current[:0]
	}

	for _, rawLine := range lines {
		line := strings.TrimRight(rawLine, "\r")
		if markdownHeadingPattern.MatchString(line) {
			hasHeading = true
			flushCurrent()
			current = append(current, line)
			continue
		}
		current = append(current, line)
	}

	flushCurrent()

	if !hasHeading {
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			return nil
		}
		return []string{trimmed}
	}

	return parts
}

func isEmptyLine(line string) bool {
	return strings.TrimSpace(line) == ""
}

func splitIntoSegments(text string) []segment {
	lines := strings.Split(text, "\n")
	var segments []segment
	var currentSentence strings.Builder

	appendSentence := func() {
		if currentSentence.Len() == 0 {
			return
		}
		segments = append(segments, segment{
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
					segments = append(segments, segment{
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

			segments = append(segments, segment{
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
				segments = append(segments, segment{
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
		segments = append(segments, segment{
			text: tableHeader,
			kind: segmentText,
		})
	}

	appendSentence()

	var result []segment
	for _, segment := range segments {
		if strings.TrimSpace(segment.text) != "" {
			result = append(result, segment)
		}
	}

	return result
}

func buildChunkText(segments []segment, start, end int) string {
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

func SplitIntoSentences(text string) []string {
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
