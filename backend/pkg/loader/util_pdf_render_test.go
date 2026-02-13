package loader

import (
	"image"
	"image/color"
	"testing"
)

func TestChoosePDFRenderMode_Auto(t *testing.T) {
	options := normalizePDFRenderOptions(PDFRenderOptions{
		Mode:                     pdfRenderModeAuto,
		DefaultDPI:               200,
		LargePageDPI:             320,
		PreviewDPI:               72,
		LargePageEdgeThresholdPx: 3400,
		LargePageAreaThresholdPx: 14000000,
	})

	mode, dpi := choosePDFRenderMode(options, 800, 1100)
	if mode != pdfRenderModeFull {
		t.Fatalf("expected full mode for regular page, got %s", mode)
	}
	if dpi != 200 {
		t.Fatalf("expected default DPI 200, got %d", dpi)
	}

	mode, dpi = choosePDFRenderMode(options, 2200, 3100)
	if mode != pdfRenderModeTile {
		t.Fatalf("expected tile mode for large page, got %s", mode)
	}
	if dpi != 320 {
		t.Fatalf("expected tile DPI 320, got %d", dpi)
	}
}

func TestDetectPDFPanelRegions_LayoutSplit(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1000, 700))
	fillImage(img, color.RGBA{R: 255, G: 255, B: 255, A: 255})

	drawVerticalLine(img, 250)
	drawVerticalLine(img, 800)
	drawHorizontalLine(img, 500)

	options := normalizePDFRenderOptions(PDFRenderOptions{
		EnablePanelSplit:          true,
		PanelSeparatorMinCoverage: 0.45,
	})

	regions := detectPDFPanelRegions(img, options)
	if len(regions) != 6 {
		t.Fatalf("expected 6 split regions, got %d", len(regions))
	}

	first := regions[0]
	if first.Min.X != 0 || first.Max.X != 251 || first.Min.Y != 0 || first.Max.Y != 501 {
		t.Fatalf("unexpected first region: %+v", first)
	}
}

func TestBuildTilesForRegion(t *testing.T) {
	region := image.Rect(0, 0, 5000, 3000)
	tiles := buildTilesForRegion(region, 2000, 100)

	if len(tiles) != 6 {
		t.Fatalf("expected 6 tiles, got %d", len(tiles))
	}

	if tiles[0] != (pdfCropRect{X: 0, Y: 0, W: 2000, H: 2000}) {
		t.Fatalf("unexpected first tile: %+v", tiles[0])
	}

	last := tiles[len(tiles)-1]
	if last != (pdfCropRect{X: 3000, Y: 1000, W: 2000, H: 2000}) {
		t.Fatalf("unexpected last tile: %+v", last)
	}
}

func fillImage(img *image.RGBA, c color.RGBA) {
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
			img.SetRGBA(x, y, c)
		}
	}
}

func drawVerticalLine(img *image.RGBA, x int) {
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		img.SetRGBA(x, y, color.RGBA{A: 255})
	}
}

func drawHorizontalLine(img *image.RGBA, y int) {
	for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
		img.SetRGBA(x, y, color.RGBA{A: 255})
	}
}
