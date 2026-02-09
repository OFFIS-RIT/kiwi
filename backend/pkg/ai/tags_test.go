package ai

import (
	"strings"
	"testing"
)

func TestStripMetadataTags_RemovesMetadataSections(t *testing.T) {
	input := strings.Join([]string{
		"<doc-header>Bebauungsplan N-777 F</doc-header>",
		"<doc-header>Seite 2 von 21</doc-header>",
		"<doc-toc>1 Allgemeines .... 2\n2 Ergebnisse .... 10</doc-toc>",
		"Main body paragraph.",
		"<doc-footer>Seite 2</doc-footer>",
		"<doc-signature>Signed by A</doc-signature>",
	}, "\n\n")

	cleaned := StripMetadataTags(input)

	if strings.Contains(cleaned, "<doc-header>") || strings.Contains(cleaned, "<doc-footer>") || strings.Contains(cleaned, "<doc-signature>") || strings.Contains(cleaned, "<doc-toc>") {
		t.Fatalf("StripMetadataTags() should remove all metadata tags, got %q", cleaned)
	}

	if !strings.Contains(cleaned, "Main body paragraph.") {
		t.Fatalf("StripMetadataTags() should preserve main content, got %q", cleaned)
	}
}

func TestStripMetadataTags_KeepsImageTags(t *testing.T) {
	input := strings.Join([]string{
		"<doc-header>Header</doc-header>",
		"Intro text.",
		"<image>A map showing traffic routes and noise zones.</image>",
		"<doc-footer>Footer</doc-footer>",
	}, "\n\n")

	cleaned := StripMetadataTags(input)

	if !strings.Contains(cleaned, "<image>A map showing traffic routes and noise zones.</image>") {
		t.Fatalf("StripMetadataTags() should preserve image tags, got %q", cleaned)
	}

	if strings.Contains(cleaned, "<doc-header>") || strings.Contains(cleaned, "<doc-footer>") {
		t.Fatalf("StripMetadataTags() should still remove metadata tags, got %q", cleaned)
	}
}
