package loader

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	gonanoid "github.com/matoous/go-nanoid/v2"
)

// TransformDocToPdf converts a document file (docx, doc, odt, etc.) to PDF using unoconv.
// The ext parameter should be the file extension without the leading dot (e.g., "docx").
func TransformDocToPdf(input []byte, ext string) ([]byte, error) {
	id, err := gonanoid.New()
	if err != nil {
		return nil, fmt.Errorf("nanoid: %w", err)
	}
	tmpDir := filepath.Join(os.TempDir(), "kiwi-ocr-"+id)
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir tmp: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	docPath := filepath.Join(tmpDir, fmt.Sprintf("input.%s", ext))
	if err := os.WriteFile(docPath, input, 0o600); err != nil {
		return nil, fmt.Errorf("write docx: %w", err)
	}

	if _, err := exec.LookPath("unoconv"); err != nil {
		return nil, fmt.Errorf("unoconv not found in PATH: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Second)
	defer cancel()

	pdfPath := filepath.Join(tmpDir, "input.pdf")
	cmd := exec.CommandContext(ctx, "unoconv", "-f", "pdf", "-o", pdfPath, docPath)
	cmd.Dir = tmpDir
	cmd.Env = append(os.Environ(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8")
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("unoconv timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("unoconv failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	if _, statErr := os.Stat(pdfPath); statErr != nil {
		matches, globErr := filepath.Glob(filepath.Join(tmpDir, "*.pdf"))
		if globErr != nil || len(matches) == 0 {
			return nil, fmt.Errorf("read converted pdf: %v; stderr: %s", statErr, strings.TrimSpace(string(out)))
		}
		pdfPath = matches[0]
	}
	pdfBytes, err := os.ReadFile(pdfPath)
	if err != nil {
		return nil, fmt.Errorf("read converted pdf: %w", err)
	}

	return pdfBytes, nil
}

// TransformDocToImages converts a document file to a slice of PNG images, one per page.
// It first converts to PDF using unoconv, then renders each page as an image.
func TransformDocToImages(input []byte, ext string) ([][]byte, error) {
	id, err := gonanoid.New()
	if err != nil {
		return nil, fmt.Errorf("nanoid: %w", err)
	}
	tmpDir := filepath.Join(os.TempDir(), "kiwi-ocr-"+id)
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir tmp: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	docPath := filepath.Join(tmpDir, fmt.Sprintf("input.%s", ext))
	if err := os.WriteFile(docPath, input, 0o600); err != nil {
		return nil, fmt.Errorf("write docx: %w", err)
	}

	if _, err := exec.LookPath("unoconv"); err != nil {
		return nil, fmt.Errorf("unoconv not found in PATH: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Second)
	defer cancel()

	pdfPath := filepath.Join(tmpDir, "input.pdf")
	cmd := exec.CommandContext(ctx, "unoconv", "-f", "pdf", "-o", pdfPath, docPath)
	cmd.Dir = tmpDir
	cmd.Env = append(os.Environ(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8")
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("unoconv timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("unoconv failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	if _, statErr := os.Stat(pdfPath); statErr != nil {
		matches, globErr := filepath.Glob(filepath.Join(tmpDir, "*.pdf"))
		if globErr != nil || len(matches) == 0 {
			return nil, fmt.Errorf("read converted pdf: %v; stderr: %s", statErr, strings.TrimSpace(string(out)))
		}
		pdfPath = matches[0]
	}
	pdfBytes, err := os.ReadFile(pdfPath)
	if err != nil {
		return nil, fmt.Errorf("read converted pdf: %w", err)
	}

	return TransformPdfToImages(pdfBytes)
}

// TransformPdfToImages converts a PDF to a slice of PNG images, one per page.
// It uses pdftoppm at 200 DPI for good quality text recognition.
func TransformPdfToImages(input []byte) ([][]byte, error) {
	id, err := gonanoid.New()
	if err != nil {
		return nil, fmt.Errorf("nanoid: %w", err)
	}
	tmpDir := filepath.Join(os.TempDir(), "kiwi-ocr-"+id)
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir tmp: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	pdfPath := filepath.Join(tmpDir, "input.pdf")
	if err := os.WriteFile(pdfPath, input, 0o600); err != nil {
		return nil, fmt.Errorf("write pdf: %w", err)
	}

	if _, err := exec.LookPath("pdftoppm"); err != nil {
		return nil, fmt.Errorf("pdftoppm not found in PATH: %w", err)
	}

	prefix := filepath.Join(tmpDir, "page")
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "pdftoppm", "-png", "-r", "200", "-q", pdfPath, prefix)
	cmd.Env = append(os.Environ(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8")
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("pdftoppm timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("pdftoppm failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	matches, err := filepath.Glob(filepath.Join(tmpDir, "page-*.png"))
	if err != nil {
		return nil, fmt.Errorf("glob images: %w", err)
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("no images produced")
	}

	sort.Slice(matches, func(i, j int) bool {
		return extractPageNum(matches[i]) < extractPageNum(matches[j])
	})

	images := make([][]byte, 0, len(matches))
	for _, f := range matches {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read image %s: %w", f, err)
		}
		images = append(images, b)
	}

	return images, nil
}

func extractPageNum(path string) int {
	base := filepath.Base(path)
	base = strings.TrimSuffix(base, ".png")
	idx := strings.LastIndexByte(base, '-')
	if idx == -1 || idx+1 >= len(base) {
		return 0
	}
	n, _ := strconv.Atoi(base[idx+1:])
	return n
}

// CountPDFPages returns the number of pages in a PDF document
func CountPDFPages(input []byte) (int, error) {
	id, err := gonanoid.New()
	if err != nil {
		return 0, fmt.Errorf("nanoid: %w", err)
	}
	tmpDir := filepath.Join(os.TempDir(), "kiwi-count-"+id)
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return 0, fmt.Errorf("mkdir tmp: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	pdfPath := filepath.Join(tmpDir, "input.pdf")
	if err := os.WriteFile(pdfPath, input, 0o600); err != nil {
		return 0, fmt.Errorf("write pdf: %w", err)
	}

	// Try pdfinfo first (faster)
	if _, err := exec.LookPath("pdfinfo"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		cmd := exec.CommandContext(ctx, "pdfinfo", pdfPath)
		out, err := cmd.Output()
		if err == nil {
			lines := strings.SplitSeq(string(out), "\n")
			for line := range lines {
				if strings.HasPrefix(line, "Pages:") {
					parts := strings.Fields(line)
					if len(parts) >= 2 {
						if pages, err := strconv.Atoi(parts[1]); err == nil {
							return pages, nil
						}
					}
				}
			}
		}
	}

	// Fallback: use pdftoppm to count pages
	if _, err := exec.LookPath("pdftoppm"); err != nil {
		return 0, fmt.Errorf("neither pdfinfo nor pdftoppm found in PATH")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	prefix := filepath.Join(tmpDir, "page")
	cmd := exec.CommandContext(ctx, "pdftoppm", "-png", "-r", "72", "-singlefile", "-f", "1", "-l", "1", pdfPath, prefix)
	cmd.Env = append(os.Environ(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8")
	if err := cmd.Run(); err != nil {
		return 0, fmt.Errorf("pdftoppm failed: %w", err)
	}

	return 1, nil
}

// CacheKey generates a unique cache key for a GraphFile based on its ID and path.
func CacheKey(file GraphFile) string {
	return file.ID + ":" + file.FilePath
}

var markdownImageTagPattern = regexp.MustCompile(`!\[([^\]]*)\]\([^)]*\)`)

// NormalizeMarkdownImageDescriptions replaces markdown image tags with <image> tags
// and de-duplicates repeated descriptions based on normalized whitespace.
func NormalizeMarkdownImageDescriptions(content string) string {
	for {
		match := markdownImageTagPattern.FindStringSubmatchIndex(content)
		if match == nil {
			return content
		}

		tagStart, tagEnd := match[0], match[1]
		altStart, altEnd := match[2], match[3]
		alt := content[altStart:altEnd]
		altTokens := strings.Fields(alt)
		if len(altTokens) == 0 {
			content = content[:tagStart] + content[tagEnd:]
			continue
		}

		matchStart, matchEnd, found := findTokenSequence(content, tagEnd, altTokens)
		if found {
			between := content[tagEnd:matchStart]
			if strings.HasSuffix(content[:tagStart], "\n") && strings.HasPrefix(between, "\n") {
				between = between[1:]
			}
			content = content[:tagStart] + between + "<image>" + content[matchStart:matchEnd] + "</image>" + content[matchEnd:]
			continue
		}

		content = content[:tagStart] + "<image>" + alt + "</image>" + content[tagEnd:]
	}
}

type tokenPosition struct {
	text  string
	start int
	end   int
}

func findTokenSequence(content string, startIndex int, tokens []string) (int, int, bool) {
	if len(tokens) == 0 || startIndex >= len(content) {
		return 0, 0, false
	}
	if startIndex < 0 {
		startIndex = 0
	}

	contentTokens := tokenizeWithPositions(content, startIndex)
	if len(contentTokens) < len(tokens) {
		return 0, 0, false
	}

	for i := 0; i <= len(contentTokens)-len(tokens); i++ {
		if contentTokens[i].text != tokens[0] {
			continue
		}
		matched := true
		for j := 1; j < len(tokens); j++ {
			if contentTokens[i+j].text != tokens[j] {
				matched = false
				break
			}
		}
		if matched {
			return contentTokens[i].start, contentTokens[i+len(tokens)-1].end, true
		}
	}

	return 0, 0, false
}

func tokenizeWithPositions(content string, startIndex int) []tokenPosition {
	if startIndex < 0 {
		startIndex = 0
	}
	if startIndex >= len(content) {
		return nil
	}

	segment := content[startIndex:]
	positions := make([]tokenPosition, 0)
	inToken := false
	tokenStart := 0

	for i, r := range segment {
		if unicode.IsSpace(r) {
			if inToken {
				positions = append(positions, tokenPosition{
					text:  segment[tokenStart:i],
					start: startIndex + tokenStart,
					end:   startIndex + i,
				})
				inToken = false
			}
			continue
		}

		if !inToken {
			inToken = true
			tokenStart = i
		}
	}

	if inToken {
		positions = append(positions, tokenPosition{
			text:  segment[tokenStart:],
			start: startIndex + tokenStart,
			end:   startIndex + len(segment),
		})
	}

	return positions
}

// TransformExcelToCsv converts an Excel file (.xlsx, .xls) to CSV files using unoconv.
// For multi-sheet workbooks, unoconv outputs one CSV per sheet.
// Returns a map of sheet name -> CSV content.
func TransformExcelToCsv(input []byte, ext string) (map[string][]byte, error) {
	id, err := gonanoid.New()
	if err != nil {
		return nil, fmt.Errorf("nanoid: %w", err)
	}
	tmpDir := filepath.Join(os.TempDir(), "kiwi-excel-"+id)
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir tmp: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	excelPath := filepath.Join(tmpDir, fmt.Sprintf("input.%s", ext))
	if err := os.WriteFile(excelPath, input, 0o600); err != nil {
		return nil, fmt.Errorf("write excel: %w", err)
	}

	if _, err := exec.LookPath("unoconv"); err != nil {
		return nil, fmt.Errorf("unoconv not found in PATH: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "unoconv", "-f", "csv", excelPath)
	cmd.Dir = tmpDir
	cmd.Env = append(os.Environ(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8")
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("unoconv timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("unoconv failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	// unoconv outputs CSV files in the same directory
	// For single sheet: input.csv
	// For multi-sheet: input-SheetName.csv for each sheet
	matches, err := filepath.Glob(filepath.Join(tmpDir, "*.csv"))
	if err != nil {
		return nil, fmt.Errorf("glob csv: %w", err)
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("no CSV files produced")
	}

	result := make(map[string][]byte, len(matches))
	for _, f := range matches {
		content, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read csv %s: %w", f, err)
		}

		// Extract sheet name from filename
		base := filepath.Base(f)
		base = strings.TrimSuffix(base, ".csv")

		// Remove "input-" prefix if present, otherwise use "Sheet1"
		sheetName := strings.TrimPrefix(base, "input-")
		if sheetName == "input" {
			sheetName = "Sheet1"
		}

		result[sheetName] = content
	}

	return result, nil
}
