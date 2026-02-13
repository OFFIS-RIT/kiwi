package loader

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
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

	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

type pdfRenderMode string

const (
	pdfRenderModeAuto pdfRenderMode = "auto"
	pdfRenderModeFull pdfRenderMode = "full"
	pdfRenderModeTile pdfRenderMode = "tile"
)

type PDFRenderOptions struct {
	Mode                      pdfRenderMode
	DefaultDPI                int
	LargePageDPI              int
	PreviewDPI                int
	TileMaxEdgePx             int
	TileOverlapPx             int
	LargePageEdgeThresholdPx  int
	LargePageAreaThresholdPx  int
	EnablePanelSplit          bool
	PanelSeparatorMinCoverage float64
	MaxTilesPerPage           int
}

type pdfCropRect struct {
	X int
	Y int
	W int
	H int
}

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
func TransformDocToImages(ctx context.Context, input []byte, ext string) ([][]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}

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

	ctx, cancel := context.WithTimeout(ctx, 600*time.Second)
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

	return TransformPdfToImages(ctx, pdfBytes)
}

// TransformPdfToImages converts a PDF to a slice of PNG images, one per page.
// It uses pdftoppm at 200 DPI for good quality text recognition.
func TransformPdfToImages(ctx context.Context, input []byte) ([][]byte, error) {
	return TransformPdfToImagesWithOptions(ctx, input, defaultPDFRenderOptionsFromEnv())
}

// TransformPdfToImagesWithOptions converts a PDF to PNG images using adaptive
// rendering. For large pages, it can switch to tiled rendering and optional
// panel-aware splitting for better OCR fidelity.
func TransformPdfToImagesWithOptions(ctx context.Context, input []byte, options PDFRenderOptions) ([][]byte, error) {
	options = normalizePDFRenderOptions(options)
	if ctx == nil {
		ctx = context.Background()
	}

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

	ctx, cancel := context.WithTimeout(ctx, 600*time.Second)
	defer cancel()

	if options.Mode == pdfRenderModeFull {
		return renderAllPDFPages(ctx, tmpDir, pdfPath, options.DefaultDPI, "page")
	}

	previewPaths, err := renderAllPDFPagePaths(ctx, tmpDir, pdfPath, options.PreviewDPI, "preview")
	if err != nil {
		return nil, err
	}
	if len(previewPaths) == 0 {
		return nil, fmt.Errorf("no preview images produced")
	}

	images := make([][]byte, 0, len(previewPaths))
	for _, previewPath := range previewPaths {
		pageNum := extractPageNum(previewPath)
		previewBytes, err := os.ReadFile(previewPath)
		if err != nil {
			return nil, fmt.Errorf("read preview image %s: %w", previewPath, err)
		}

		previewImg, err := png.Decode(bytes.NewReader(previewBytes))
		if err != nil {
			return nil, fmt.Errorf("decode preview image %s: %w", previewPath, err)
		}

		mode, targetDPI := choosePDFRenderMode(options, previewImg.Bounds().Dx(), previewImg.Bounds().Dy())
		if mode == pdfRenderModeFull {
			prefix := filepath.Join(tmpDir, fmt.Sprintf("page-%04d", pageNum))
			imgBytes, err := renderPDFPage(ctx, pdfPath, prefix, pageNum, targetDPI, nil)
			if err != nil {
				return nil, err
			}
			images = append(images, imgBytes)
			continue
		}

		regions := []image.Rectangle{previewImg.Bounds()}
		if options.EnablePanelSplit {
			regions = detectPDFPanelRegions(previewImg, options)
		}

		targetRegions := make([]image.Rectangle, 0, len(regions))
		targetW := scaleDimension(previewImg.Bounds().Dx(), targetDPI, options.PreviewDPI)
		targetH := scaleDimension(previewImg.Bounds().Dy(), targetDPI, options.PreviewDPI)
		for _, region := range regions {
			scaled := scaleRectToTarget(region, previewImg.Bounds(), targetW, targetH)
			if scaled.Dx() <= 0 || scaled.Dy() <= 0 {
				continue
			}
			targetRegions = append(targetRegions, scaled)
		}
		if len(targetRegions) == 0 {
			targetRegions = append(targetRegions, image.Rect(0, 0, targetW, targetH))
		}

		tiles := buildTilesForRegions(targetRegions, options.TileMaxEdgePx, options.TileOverlapPx, options.MaxTilesPerPage)
		if len(tiles) == 0 {
			prefix := filepath.Join(tmpDir, fmt.Sprintf("page-%04d", pageNum))
			imgBytes, err := renderPDFPage(ctx, pdfPath, prefix, pageNum, targetDPI, nil)
			if err != nil {
				return nil, err
			}
			images = append(images, imgBytes)
			continue
		}

		for idx, tile := range tiles {
			prefix := filepath.Join(tmpDir, fmt.Sprintf("page-%04d-tile-%04d", pageNum, idx+1))
			imgBytes, err := renderPDFPage(ctx, pdfPath, prefix, pageNum, targetDPI, &tile)
			if err != nil {
				return nil, err
			}
			images = append(images, imgBytes)
		}
	}

	return images, nil
}

func defaultPDFRenderOptionsFromEnv() PDFRenderOptions {
	modeValue := strings.ToLower(strings.TrimSpace(os.Getenv("PDF_RENDER_MODE")))
	mode := pdfRenderModeAuto
	if modeValue != "" {
		switch modeValue {
		case string(pdfRenderModeAuto), string(pdfRenderModeFull), string(pdfRenderModeTile):
			mode = pdfRenderMode(modeValue)
		default:
			logger.Warn("Invalid PDF render mode, falling back to auto", "env", "PDF_RENDER_MODE", "value", modeValue)
		}
	}

	return PDFRenderOptions{
		Mode:                      mode,
		DefaultDPI:                readEnvInt("PDF_DPI_DEFAULT", 200),
		LargePageDPI:              readEnvInt("PDF_DPI_LARGE_PAGE", 320),
		PreviewDPI:                readEnvInt("PDF_PREVIEW_DPI", 72),
		TileMaxEdgePx:             readEnvInt("PDF_TILE_MAX_EDGE_PX", 2200),
		TileOverlapPx:             readEnvInt("PDF_TILE_OVERLAP_PX", 96),
		LargePageEdgeThresholdPx:  readEnvInt("PDF_LARGE_PAGE_EDGE_THRESHOLD_PX", 3400),
		LargePageAreaThresholdPx:  readEnvInt("PDF_LARGE_PAGE_AREA_THRESHOLD_PX", 14000000),
		EnablePanelSplit:          readEnvBool("PDF_ENABLE_PANEL_SPLIT", true),
		PanelSeparatorMinCoverage: readEnvFloat("PDF_PANEL_SEPARATOR_MIN_COVERAGE", 0.45),
		MaxTilesPerPage:           readEnvInt("PDF_MAX_TILES_PER_PAGE", 24),
	}
}

func normalizePDFRenderOptions(options PDFRenderOptions) PDFRenderOptions {
	if options.Mode != pdfRenderModeFull && options.Mode != pdfRenderModeTile && options.Mode != pdfRenderModeAuto {
		options.Mode = pdfRenderModeAuto
	}
	if options.DefaultDPI <= 0 {
		options.DefaultDPI = 200
	}
	if options.LargePageDPI <= 0 {
		options.LargePageDPI = 320
	}
	if options.PreviewDPI <= 0 {
		options.PreviewDPI = 72
	}
	if options.TileMaxEdgePx <= 0 {
		options.TileMaxEdgePx = 2200
	}
	if options.TileOverlapPx < 0 {
		options.TileOverlapPx = 0
	}
	if options.TileOverlapPx >= options.TileMaxEdgePx {
		options.TileOverlapPx = options.TileMaxEdgePx / 4
	}
	if options.LargePageEdgeThresholdPx <= 0 {
		options.LargePageEdgeThresholdPx = 3400
	}
	if options.LargePageAreaThresholdPx <= 0 {
		options.LargePageAreaThresholdPx = 14000000
	}
	if options.PanelSeparatorMinCoverage <= 0 || options.PanelSeparatorMinCoverage >= 1 {
		options.PanelSeparatorMinCoverage = 0.45
	}
	if options.MaxTilesPerPage <= 0 {
		options.MaxTilesPerPage = 24
	}

	return options
}

func readEnvInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return fallback
	}
	return v
}

func readEnvBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return v
}

func readEnvFloat(key string, fallback float64) float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fallback
	}
	return v
}

func choosePDFRenderMode(options PDFRenderOptions, previewWidth int, previewHeight int) (pdfRenderMode, int) {
	if options.Mode == pdfRenderModeFull {
		return pdfRenderModeFull, options.DefaultDPI
	}

	tileDPI := max(options.DefaultDPI, options.LargePageDPI)
	if options.Mode == pdfRenderModeTile {
		return pdfRenderModeTile, tileDPI
	}

	renderW := scaleDimension(previewWidth, options.DefaultDPI, options.PreviewDPI)
	renderH := scaleDimension(previewHeight, options.DefaultDPI, options.PreviewDPI)
	if renderW >= options.LargePageEdgeThresholdPx || renderH >= options.LargePageEdgeThresholdPx {
		return pdfRenderModeTile, tileDPI
	}
	if renderW > 0 && renderH > 0 && renderW*renderH >= options.LargePageAreaThresholdPx {
		return pdfRenderModeTile, tileDPI
	}

	return pdfRenderModeFull, options.DefaultDPI
}

func renderAllPDFPages(
	ctx context.Context,
	tmpDir string,
	pdfPath string,
	dpi int,
	prefix string,
) ([][]byte, error) {
	paths, err := renderAllPDFPagePaths(ctx, tmpDir, pdfPath, dpi, prefix)
	if err != nil {
		return nil, err
	}

	images := make([][]byte, 0, len(paths))
	for _, f := range paths {
		b, readErr := os.ReadFile(f)
		if readErr != nil {
			return nil, fmt.Errorf("read image %s: %w", f, readErr)
		}
		images = append(images, b)
	}

	return images, nil
}

func renderAllPDFPagePaths(
	ctx context.Context,
	tmpDir string,
	pdfPath string,
	dpi int,
	prefix string,
) ([]string, error) {
	filePrefix := filepath.Join(tmpDir, prefix)
	cmd := exec.CommandContext(ctx, "pdftoppm", "-png", "-r", strconv.Itoa(dpi), "-q", pdfPath, filePrefix)
	cmd.Env = append(os.Environ(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8")
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("pdftoppm timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("pdftoppm failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	paths, err := filepath.Glob(filePrefix + "-*.png")
	if err != nil {
		return nil, fmt.Errorf("glob images: %w", err)
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no images produced")
	}

	sort.Slice(paths, func(i, j int) bool {
		return extractPageNum(paths[i]) < extractPageNum(paths[j])
	})

	return paths, nil
}

func renderPDFPage(
	ctx context.Context,
	pdfPath string,
	prefix string,
	pageNum int,
	dpi int,
	crop *pdfCropRect,
) ([]byte, error) {
	args := []string{
		"-png",
		"-r", strconv.Itoa(dpi),
		"-q",
		"-singlefile",
		"-f", strconv.Itoa(pageNum),
		"-l", strconv.Itoa(pageNum),
	}

	if crop != nil {
		if crop.W <= 0 || crop.H <= 0 {
			return nil, fmt.Errorf("invalid crop for page %d: %+v", pageNum, *crop)
		}
		args = append(args,
			"-x", strconv.Itoa(crop.X),
			"-y", strconv.Itoa(crop.Y),
			"-W", strconv.Itoa(crop.W),
			"-H", strconv.Itoa(crop.H),
		)
	}

	args = append(args, pdfPath, prefix)

	cmd := exec.CommandContext(ctx, "pdftoppm", args...)
	cmd.Env = append(os.Environ(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8")
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("pdftoppm timed out on page %d", pageNum)
	}
	if err != nil {
		return nil, fmt.Errorf("pdftoppm failed on page %d: %w: %s", pageNum, err, strings.TrimSpace(string(out)))
	}

	imagePath := prefix + ".png"
	b, err := os.ReadFile(imagePath)
	if err != nil {
		return nil, fmt.Errorf("read image %s: %w", imagePath, err)
	}

	return b, nil
}

func scaleDimension(value int, targetDPI int, sourceDPI int) int {
	if value <= 0 || targetDPI <= 0 || sourceDPI <= 0 {
		return 0
	}
	return int(math.Round(float64(value) * float64(targetDPI) / float64(sourceDPI)))
}

func detectPDFPanelRegions(img image.Image, options PDFRenderOptions) []image.Rectangle {
	bounds := img.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return nil
	}

	fallback := []image.Rectangle{image.Rect(0, 0, bounds.Dx(), bounds.Dy())}
	if !options.EnablePanelSplit {
		return fallback
	}

	width := bounds.Dx()
	height := bounds.Dy()
	if width < 400 || height < 400 {
		return fallback
	}

	colCoverage, rowCoverage := computeSeparatorCoverage(img)
	leftSep, leftOK := strongestCoverageIndex(colCoverage, int(float64(width)*0.15), int(float64(width)*0.45), options.PanelSeparatorMinCoverage)
	rightSep, rightOK := strongestCoverageIndex(colCoverage, int(float64(width)*0.55), int(float64(width)*0.92), options.PanelSeparatorMinCoverage)
	bottomSep, bottomOK := strongestCoverageIndex(rowCoverage, int(float64(height)*0.55), int(float64(height)*0.95), options.PanelSeparatorMinCoverage)

	type xBand struct {
		min int
		max int
	}
	bands := make([]xBand, 0, 3)

	minBandWidth := max(100, int(float64(width)*0.08))
	if leftOK && rightOK && rightSep-leftSep >= minBandWidth*2 {
		bands = append(bands,
			xBand{min: 0, max: leftSep + 1},
			xBand{min: leftSep + 1, max: rightSep + 1},
			xBand{min: rightSep + 1, max: width},
		)
	} else {
		bands = append(bands, xBand{min: 0, max: width})
	}

	regions := make([]image.Rectangle, 0, len(bands)*2)
	minBottomTop := int(float64(height) * 0.45)
	minBottomHeight := int(float64(height) * 0.12)
	for _, band := range bands {
		if band.max-band.min < minBandWidth {
			continue
		}

		if bottomOK && bottomSep >= minBottomTop && (height-(bottomSep+1)) >= minBottomHeight {
			top := image.Rect(band.min, 0, band.max, bottomSep+1)
			bottom := image.Rect(band.min, bottomSep+1, band.max, height)
			if top.Dx() > 0 && top.Dy() > 0 {
				regions = append(regions, top)
			}
			if bottom.Dx() > 0 && bottom.Dy() > 0 {
				regions = append(regions, bottom)
			}
			continue
		}

		region := image.Rect(band.min, 0, band.max, height)
		regions = append(regions, region)
	}

	if len(regions) == 0 {
		return fallback
	}

	return regions
}

func computeSeparatorCoverage(img image.Image) ([]float64, []float64) {
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()

	colDark := make([]int, width)
	rowDark := make([]int, height)

	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			if !isSeparatorPixelDark(img.At(x, y)) {
				continue
			}
			colDark[x-bounds.Min.X]++
			rowDark[y-bounds.Min.Y]++
		}
	}

	colCoverage := make([]float64, width)
	for x := 0; x < width; x++ {
		colCoverage[x] = float64(colDark[x]) / float64(height)
	}

	rowCoverage := make([]float64, height)
	for y := 0; y < height; y++ {
		rowCoverage[y] = float64(rowDark[y]) / float64(width)
	}

	return colCoverage, rowCoverage
}

func strongestCoverageIndex(values []float64, start int, end int, minCoverage float64) (int, bool) {
	if len(values) == 0 {
		return 0, false
	}
	if start < 0 {
		start = 0
	}
	if end > len(values) {
		end = len(values)
	}
	if start >= end {
		return 0, false
	}

	bestIndex := -1
	bestCoverage := minCoverage
	for idx := start; idx < end; idx++ {
		if values[idx] <= bestCoverage {
			continue
		}
		bestCoverage = values[idx]
		bestIndex = idx
	}

	if bestIndex == -1 {
		return 0, false
	}

	return bestIndex, true
}

func isSeparatorPixelDark(c color.Color) bool {
	r, g, b, _ := c.RGBA()
	gray := (299*r + 587*g + 114*b) / 1000
	return gray <= uint32(90*257)
}

func scaleRectToTarget(region image.Rectangle, sourceBounds image.Rectangle, targetW int, targetH int) image.Rectangle {
	sourceW := sourceBounds.Dx()
	sourceH := sourceBounds.Dy()
	if sourceW <= 0 || sourceH <= 0 || targetW <= 0 || targetH <= 0 {
		return image.Rectangle{}
	}

	minX := scaleFloor(region.Min.X-sourceBounds.Min.X, targetW, sourceW)
	minY := scaleFloor(region.Min.Y-sourceBounds.Min.Y, targetH, sourceH)
	maxX := scaleCeil(region.Max.X-sourceBounds.Min.X, targetW, sourceW)
	maxY := scaleCeil(region.Max.Y-sourceBounds.Min.Y, targetH, sourceH)

	minX = clamp(minX, 0, targetW)
	minY = clamp(minY, 0, targetH)
	maxX = clamp(maxX, 0, targetW)
	maxY = clamp(maxY, 0, targetH)

	if maxX <= minX || maxY <= minY {
		return image.Rectangle{}
	}

	return image.Rect(minX, minY, maxX, maxY)
}

func scaleFloor(value int, target int, source int) int {
	if source <= 0 {
		return 0
	}
	return value * target / source
}

func scaleCeil(value int, target int, source int) int {
	if source <= 0 {
		return 0
	}
	return (value*target + source - 1) / source
}

func clamp(v int, minV int, maxV int) int {
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

func buildTilesForRegions(regions []image.Rectangle, tileEdge int, overlap int, maxTiles int) []pdfCropRect {
	if len(regions) == 0 || tileEdge <= 0 {
		return nil
	}

	tiles := []pdfCropRect{}
	currentTileEdge := tileEdge
	for attempt := 0; attempt < 5; attempt++ {
		tiles = make([]pdfCropRect, 0, len(regions)*4)
		for _, region := range regions {
			regionTiles := buildTilesForRegion(region, currentTileEdge, overlap)
			tiles = append(tiles, regionTiles...)
		}

		if maxTiles <= 0 || len(tiles) <= maxTiles {
			break
		}

		currentTileEdge = int(float64(currentTileEdge) * 1.25)
	}

	return dedupeTiles(tiles)
}

func buildTilesForRegion(region image.Rectangle, tileEdge int, overlap int) []pdfCropRect {
	if region.Dx() <= 0 || region.Dy() <= 0 || tileEdge <= 0 {
		return nil
	}

	xStarts := buildTileAxisStarts(region.Min.X, region.Max.X, tileEdge, overlap)
	yStarts := buildTileAxisStarts(region.Min.Y, region.Max.Y, tileEdge, overlap)

	tiles := make([]pdfCropRect, 0, len(xStarts)*len(yStarts))
	for _, y := range yStarts {
		h := min(tileEdge, region.Max.Y-y)
		for _, x := range xStarts {
			w := min(tileEdge, region.Max.X-x)
			tiles = append(tiles, pdfCropRect{X: x, Y: y, W: w, H: h})
		}
	}

	return tiles
}

func buildTileAxisStarts(minPos int, maxPos int, tileEdge int, overlap int) []int {
	span := maxPos - minPos
	if span <= tileEdge {
		return []int{minPos}
	}

	step := tileEdge - overlap
	if step <= 0 {
		step = tileEdge
	}

	starts := []int{minPos}
	for {
		next := starts[len(starts)-1] + step
		if next+tileEdge >= maxPos {
			break
		}
		starts = append(starts, next)
	}

	last := maxPos - tileEdge
	if last < minPos {
		last = minPos
	}
	if starts[len(starts)-1] != last {
		starts = append(starts, last)
	}

	return starts
}

func dedupeTiles(tiles []pdfCropRect) []pdfCropRect {
	if len(tiles) <= 1 {
		return tiles
	}

	seen := make(map[string]struct{}, len(tiles))
	res := make([]pdfCropRect, 0, len(tiles))
	for _, tile := range tiles {
		key := fmt.Sprintf("%d:%d:%d:%d", tile.X, tile.Y, tile.W, tile.H)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		res = append(res, tile)
	}

	return res
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
