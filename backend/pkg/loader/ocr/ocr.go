package ocr

import (
	"context"
	"encoding/base64"
	"fmt"
	stdhtml "html"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/loader"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

var ocrMarkupTagPattern = regexp.MustCompile(`(?i)<\s*/?\s*(table|thead|tbody|tr|th|td|div|p|br|h[1-6]|ul|ol|li|img|doc-header|doc-footer|doc-signature|image)\b`)
var ocrWhitespacePattern = regexp.MustCompile(`[ \t]+`)
var ocrExtraNewlinePattern = regexp.MustCompile(`\n{3,}`)
var ocrMetadataTagPattern = regexp.MustCompile(`(?i)<\s*(/?)\s*(doc-header|doc-footer|doc-signature|image)(?:\s+[^>]*)?\s*>`)

type ocrTableRow struct {
	cells     []string
	hasHeader bool
}

// OCRGraphLoader extracts text from images using AI vision models.
// It processes images in parallel and caches results for efficiency.
type OCRGraphLoader struct {
	loader   loader.GraphFileLoader
	aiClient ai.GraphAIClient

	cache   map[string][]byte
	cacheMu sync.RWMutex
	group   singleflight.Group
}

// NewOCRGraphLoaderParams contains configuration for creating an OCRGraphLoader.
type NewOCRGraphLoaderParams struct {
	Loader   loader.GraphFileLoader
	AIClient ai.GraphAIClient
}

// NewOCRGraphLoader creates a new OCR loader that extracts text from images using AI.
func NewOCRGraphLoader(params NewOCRGraphLoaderParams) *OCRGraphLoader {
	return &OCRGraphLoader{
		loader:   params.Loader,
		aiClient: params.AIClient,
		cache:    make(map[string][]byte),
	}
}

// ProcessImages transcribes a slice of images to text using AI vision in parallel.
// Returns the concatenated text from all images.
func (l *OCRGraphLoader) ProcessImages(ctx context.Context, file loader.GraphFile, images [][]byte) ([]byte, error) {
	output := make([][]byte, len(images))
	outputMtx := sync.Mutex{}

	g, gCtx := errgroup.WithContext(ctx)
	for i, img := range images {
		idx := i
		image := img
		g.Go(func() error {
			logger.Debug("[OCR] Processing image", "number", idx+1, "total", len(images))
			prompt := ai.TranscribePrompt
			b64String := base64.StdEncoding.EncodeToString(image)
			filePrefix := "data:image/png;base64,"
			b64 := loader.GraphBase64{
				Base64:   b64String,
				FileType: filePrefix,
			}
			desc, err := l.aiClient.GenerateImageDescription(gCtx, prompt, b64)
			if err != nil {
				return err
			}
			desc = loader.NormalizeMarkdownImageDescriptions(desc)
			desc = normalizeOCRMarkup(desc)

			outputMtx.Lock()
			output[idx] = []byte(desc)
			outputMtx.Unlock()

			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}

	var res strings.Builder
	for _, o := range output {
		fmt.Fprintf(&res, "%s\n", o)
	}

	result := []byte(res.String())

	return result, nil
}

func normalizeOCRMarkup(content string) string {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	normalized = strings.TrimSpace(normalized)
	if normalized == "" {
		return normalized
	}

	if !ocrMarkupTagPattern.MatchString(normalized) {
		return normalized
	}

	converted, err := convertOCRMarkupToMarkdown(normalized)
	if err != nil || strings.TrimSpace(converted) == "" {
		return normalized
	}

	converted = ocrExtraNewlinePattern.ReplaceAllString(converted, "\n\n")
	return strings.TrimSpace(converted)
}

func convertOCRMarkupToMarkdown(content string) (string, error) {
	content = normalizeOCRMetadataTags(content)

	context := &html.Node{Type: html.ElementNode, DataAtom: atom.Body, Data: atom.Body.String()}
	nodes, err := html.ParseFragment(strings.NewReader(content), context)
	if err != nil {
		return "", err
	}
	if len(nodes) == 0 {
		return "", nil
	}

	blocks := make([]string, 0, len(nodes))
	for _, node := range nodes {
		blocks = append(blocks, renderOCRNode(node, false)...)
	}

	return joinOCRMarkdownBlocks(blocks), nil
}

func normalizeOCRMetadataTags(content string) string {
	return ocrMetadataTagPattern.ReplaceAllStringFunc(content, func(tag string) string {
		matches := ocrMetadataTagPattern.FindStringSubmatch(tag)
		if len(matches) != 3 {
			return tag
		}

		metaTag := strings.ToLower(matches[2])

		if matches[1] == "/" {
			return "</" + metaTag + ">"
		}

		return "<" + metaTag + ">"
	})
}

func findOCRFirstElement(node *html.Node, tag string) *html.Node {
	if node == nil {
		return nil
	}
	if node.Type == html.ElementNode && strings.EqualFold(node.Data, tag) {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findOCRFirstElement(child, tag); found != nil {
			return found
		}
	}
	return nil
}

func renderOCRNode(node *html.Node, inBox bool) []string {
	if node == nil {
		return nil
	}

	switch node.Type {
	case html.TextNode:
		text := normalizeOCRInlineText(node.Data)
		if text == "" {
			return nil
		}
		return []string{text}
	case html.ElementNode:
		tag := strings.ToLower(node.Data)

		switch tag {
		case "table":
			table := renderOCRTable(node)
			if table == "" {
				return nil
			}
			return []string{table}
		case "div":
			return renderOCRDiv(node, inBox)
		case "p":
			text := extractOCRText(node)
			if text == "" {
				return nil
			}
			return []string{text}
		case "ul":
			list := renderOCRList(node, false)
			if list == "" {
				return nil
			}
			return []string{list}
		case "ol":
			list := renderOCRList(node, true)
			if list == "" {
				return nil
			}
			return []string{list}
		case "h1", "h2", "h3", "h4", "h5", "h6":
			text := extractOCRText(node)
			if text == "" {
				return nil
			}
			level, err := strconv.Atoi(tag[1:])
			if err != nil || level < 1 || level > 6 {
				level = 2
			}
			return []string{strings.Repeat("#", level) + " " + text}
		case "doc-header", "doc-footer", "doc-signature", "image":
			content := strings.Join(renderOCRChildren(node, true), "\n")
			content = strings.TrimSpace(content)
			if content == "" {
				content = extractOCRText(node)
			}
			if content == "" {
				return nil
			}
			return []string{fmt.Sprintf("<%s>%s</%s>", tag, content, tag)}
		case "img":
			alt := normalizeOCRInlineText(getOCRAttribute(node, "alt"))
			if alt == "" {
				return nil
			}
			return []string{"<image>" + alt + "</image>"}
		case "br":
			return []string{""}
		default:
			if isOCRStructuralTag(tag) {
				return renderOCRChildren(node, inBox)
			}
			text := extractOCRText(node)
			if text == "" {
				return nil
			}
			return []string{text}
		}
	default:
		return renderOCRChildren(node, inBox)
	}
}

func renderOCRDiv(node *html.Node, inBox bool) []string {
	boxCandidate := shouldRenderDivAsBox(node) && !inBox && !ocrNodeContainsTag(node, "table")
	childBlocks := renderOCRChildren(node, inBox || boxCandidate)
	childBlocks = compactOCRBlocks(childBlocks)

	if len(childBlocks) == 0 {
		text := extractOCRText(node)
		if text == "" {
			return nil
		}
		if boxCandidate {
			return []string{renderOCRBox(text)}
		}
		return []string{text}
	}

	if boxCandidate {
		return []string{renderOCRBox(strings.Join(childBlocks, "\n"))}
	}

	return childBlocks
}

func renderOCRChildren(node *html.Node, inBox bool) []string {
	blocks := make([]string, 0)
	inlineParts := make([]string, 0)

	flushInline := func() {
		if len(inlineParts) == 0 {
			return
		}
		text := normalizeOCRInlineText(strings.Join(inlineParts, " "))
		if text != "" {
			blocks = append(blocks, text)
		}
		inlineParts = inlineParts[:0]
	}

	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type == html.TextNode {
			text := normalizeOCRInlineText(child.Data)
			if text != "" {
				inlineParts = append(inlineParts, text)
			}
			continue
		}

		if child.Type == html.ElementNode && strings.EqualFold(child.Data, "br") {
			flushInline()
			continue
		}

		if child.Type == html.ElementNode && !isOCRStructuralTag(strings.ToLower(child.Data)) {
			text := extractOCRText(child)
			if text != "" {
				inlineParts = append(inlineParts, text)
			}
			continue
		}

		flushInline()
		blocks = append(blocks, renderOCRNode(child, inBox)...)
	}

	flushInline()

	return compactOCRBlocks(blocks)
}

func renderOCRList(node *html.Node, ordered bool) string {
	lines := make([]string, 0)
	index := 1

	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type != html.ElementNode || !strings.EqualFold(child.Data, "li") {
			continue
		}

		text := extractOCRText(child)
		if text == "" {
			continue
		}

		prefix := "- "
		if ordered {
			prefix = strconv.Itoa(index) + ". "
			index++
		}
		lines = append(lines, prefix+text)
	}

	return strings.Join(lines, "\n")
}

func renderOCRTable(table *html.Node) string {
	rows := make([]ocrTableRow, 0)
	collectOCRTableRows(table, &rows)
	if len(rows) == 0 {
		return ""
	}

	maxColumns := 0
	for _, row := range rows {
		if len(row.cells) > maxColumns {
			maxColumns = len(row.cells)
		}
	}
	if maxColumns == 0 {
		return ""
	}

	for i := range rows {
		for len(rows[i].cells) < maxColumns {
			rows[i].cells = append(rows[i].cells, "")
		}
		for j := range rows[i].cells {
			rows[i].cells[j] = escapeOCRTableCell(rows[i].cells[j])
		}
	}

	header := make([]string, maxColumns)
	dataStart := 0
	if rows[0].hasHeader || len(rows) > 1 {
		copy(header, rows[0].cells)
		dataStart = 1
	} else {
		for i := 0; i < maxColumns; i++ {
			header[i] = fmt.Sprintf("Column %d", i+1)
		}
	}

	for i := range header {
		if strings.TrimSpace(header[i]) == "" {
			header[i] = fmt.Sprintf("Column %d", i+1)
		}
	}

	separator := make([]string, maxColumns)
	for i := 0; i < maxColumns; i++ {
		separator[i] = "---"
	}

	var builder strings.Builder
	builder.WriteString(formatOCRTableLine(header))
	builder.WriteString("\n")
	builder.WriteString(formatOCRTableLine(separator))

	for i := dataStart; i < len(rows); i++ {
		builder.WriteString("\n")
		builder.WriteString(formatOCRTableLine(rows[i].cells))
	}

	return builder.String()
}

func collectOCRTableRows(node *html.Node, rows *[]ocrTableRow) {
	if node == nil {
		return
	}

	if node.Type == html.ElementNode && strings.EqualFold(node.Data, "tr") {
		cells, hasHeader := extractOCRTableCells(node)
		if len(cells) > 0 {
			*rows = append(*rows, ocrTableRow{cells: cells, hasHeader: hasHeader})
		}
		return
	}

	for child := node.FirstChild; child != nil; child = child.NextSibling {
		collectOCRTableRows(child, rows)
	}
}

func extractOCRTableCells(row *html.Node) ([]string, bool) {
	cells := make([]string, 0)
	hasHeader := false

	for child := row.FirstChild; child != nil; child = child.NextSibling {
		if child.Type != html.ElementNode {
			continue
		}

		tag := strings.ToLower(child.Data)
		if tag != "th" && tag != "td" {
			continue
		}

		if tag == "th" {
			hasHeader = true
		}

		cells = append(cells, extractOCRTableCellText(child))
	}

	return cells, hasHeader
}

func extractOCRTableCellText(cell *html.Node) string {
	lines := make([]string, 0)
	current := make([]string, 0)

	flushCurrent := func() {
		if len(current) == 0 {
			return
		}
		text := normalizeOCRInlineText(strings.Join(current, " "))
		if text != "" {
			lines = append(lines, text)
		}
		current = current[:0]
	}

	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node == nil {
			return
		}

		switch node.Type {
		case html.TextNode:
			text := normalizeOCRInlineText(node.Data)
			if text != "" {
				current = append(current, text)
			}
		case html.ElementNode:
			tag := strings.ToLower(node.Data)
			switch tag {
			case "br":
				flushCurrent()
				return
			case "img":
				alt := normalizeOCRInlineText(getOCRAttribute(node, "alt"))
				if alt != "" {
					current = append(current, alt)
				}
				return
			}

			for child := node.FirstChild; child != nil; child = child.NextSibling {
				walk(child)
			}

			if tag == "p" || tag == "div" {
				flushCurrent()
			}
		}
	}

	walk(cell)
	flushCurrent()

	return strings.Join(lines, "<br>")
}

func extractOCRText(node *html.Node) string {
	tokens := make([]string, 0)

	var walk func(*html.Node)
	walk = func(current *html.Node) {
		if current == nil {
			return
		}

		switch current.Type {
		case html.TextNode:
			text := normalizeOCRInlineText(current.Data)
			if text != "" {
				tokens = append(tokens, text)
			}
		case html.ElementNode:
			tag := strings.ToLower(current.Data)
			if tag == "table" {
				return
			}
			if tag == "br" {
				tokens = append(tokens, "\n")
				return
			}
			if tag == "img" {
				alt := normalizeOCRInlineText(getOCRAttribute(current, "alt"))
				if alt != "" {
					tokens = append(tokens, alt)
				}
				return
			}

			for child := current.FirstChild; child != nil; child = child.NextSibling {
				walk(child)
			}

			switch tag {
			case "p", "div", "li":
				tokens = append(tokens, "\n")
			}
		}
	}

	walk(node)

	lines := make([]string, 0)
	lineParts := make([]string, 0)

	flushLine := func() {
		if len(lineParts) == 0 {
			return
		}
		text := normalizeOCRInlineText(strings.Join(lineParts, " "))
		if text != "" {
			lines = append(lines, text)
		}
		lineParts = lineParts[:0]
	}

	for _, token := range tokens {
		if token == "\n" {
			flushLine()
			continue
		}
		lineParts = append(lineParts, token)
	}
	flushLine()

	return strings.Join(lines, "\n")
}

func normalizeOCRInlineText(text string) string {
	text = stdhtml.UnescapeString(text)
	text = strings.ReplaceAll(text, "\u00a0", " ")
	text = strings.ReplaceAll(text, "\n", " ")
	text = ocrWhitespacePattern.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}

func joinOCRMarkdownBlocks(blocks []string) string {
	clean := compactOCRBlocks(blocks)
	if len(clean) == 0 {
		return ""
	}

	joined := strings.Join(clean, "\n\n")
	joined = ocrExtraNewlinePattern.ReplaceAllString(joined, "\n\n")
	return strings.TrimSpace(joined)
}

func compactOCRBlocks(blocks []string) []string {
	clean := make([]string, 0, len(blocks))
	for _, block := range blocks {
		trimmed := strings.TrimSpace(block)
		if trimmed == "" {
			continue
		}
		clean = append(clean, trimmed)
	}
	return clean
}

func renderOCRBox(content string) string {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return ""
	}

	lines := strings.Split(trimmed, "\n")
	quoted := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		quoted = append(quoted, "> "+line)
	}

	return strings.Join(quoted, "\n")
}

func shouldRenderDivAsBox(node *html.Node) bool {
	style := strings.TrimSpace(strings.ToLower(getOCRAttribute(node, "style")))
	if style != "" {
		return true
	}

	className := strings.TrimSpace(strings.ToLower(getOCRAttribute(node, "class")))
	if strings.Contains(className, "box") || strings.Contains(className, "card") {
		return true
	}

	return false
}

func ocrNodeContainsTag(node *html.Node, tag string) bool {
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type == html.ElementNode && strings.EqualFold(child.Data, tag) {
			return true
		}
		if ocrNodeContainsTag(child, tag) {
			return true
		}
	}

	return false
}

func getOCRAttribute(node *html.Node, name string) string {
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, name) {
			return attr.Val
		}
	}
	return ""
}

func escapeOCRTableCell(cell string) string {
	escaped := strings.TrimSpace(cell)
	escaped = strings.ReplaceAll(escaped, "|", `\|`)
	escaped = strings.ReplaceAll(escaped, "\n", "<br>")
	return escaped
}

func formatOCRTableLine(cells []string) string {
	return "| " + strings.Join(cells, " | ") + " |"
}

func isOCRStructuralTag(tag string) bool {
	switch tag {
	case "div", "p", "table", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "doc-header", "doc-footer", "doc-signature", "image":
		return true
	default:
		return false
	}
}

// GetFileText loads an image file and extracts text using OCR. Results are cached.
func (l *OCRGraphLoader) GetFileText(ctx context.Context, file loader.GraphFile) ([]byte, error) {
	key := loader.CacheKey(file)

	l.cacheMu.RLock()
	if cached, ok := l.cache[key]; ok {
		l.cacheMu.RUnlock()
		return cached, nil
	}
	l.cacheMu.RUnlock()

	result, err, _ := l.group.Do(key, func() (any, error) {
		l.cacheMu.RLock()
		if cached, ok := l.cache[key]; ok {
			l.cacheMu.RUnlock()
			return cached, nil
		}
		l.cacheMu.RUnlock()

		content, err := l.loader.GetFileText(ctx, file)
		if err != nil {
			return nil, err
		}

		input := make([][]byte, 0)
		input = append(input, content)
		output, err := l.ProcessImages(ctx, file, input)
		if err != nil {
			return nil, err
		}

		l.cacheMu.Lock()
		l.cache[key] = output
		l.cacheMu.Unlock()

		return output, nil
	})

	if err != nil {
		return nil, err
	}

	return result.([]byte), nil
}

// GetBase64 returns the image encoded as base64.
func (l *OCRGraphLoader) GetBase64(ctx context.Context, file loader.GraphFile) (loader.GraphBase64, error) {
	return l.loader.GetBase64(ctx, file)
}

// InvalidateCache removes a specific file from the cache
func (l *OCRGraphLoader) InvalidateCache(file loader.GraphFile) {
	key := loader.CacheKey(file)
	l.cacheMu.Lock()
	delete(l.cache, key)
	l.cacheMu.Unlock()
}

// ClearCache removes all cached OCR results
func (l *OCRGraphLoader) ClearCache() {
	l.cacheMu.Lock()
	l.cache = make(map[string][]byte)
	l.cacheMu.Unlock()
}
