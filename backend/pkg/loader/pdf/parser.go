package pdf

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func parsePDF(input []byte) ([]byte, error) {
	tmpDir, err := os.MkdirTemp("", "pdfextract-")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	pdfPath := filepath.Join(tmpDir, "input.pdf")
	if err := os.WriteFile(pdfPath, input, 0o600); err != nil {
		return nil, fmt.Errorf("failed to write temp PDF: %w", err)
	}

	if _, err := exec.LookPath("pdftotext"); err != nil {
		return nil, fmt.Errorf("pdftotext not found in PATH: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(
		ctx,
		"pdftotext",
		"-enc", "UTF-8",
		"-eol", "unix",
		"-nopgbrk",
		"-q",
		pdfPath,
		"-",
	)
	cmd.Env = append(os.Environ(), "LANG=C.UTF-8", "LC_ALL=C.UTF-8")

	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("pdftotext timed out")
	}
	if err != nil {
		return nil, fmt.Errorf("pdftotext failed: %w: %s", err, bytes.TrimSpace(out))
	}

	text := string(out)
	text = strings.TrimSpace(text)
	reNewlines := regexp.MustCompile(`\n{3,}`)
	text = reNewlines.ReplaceAllString(text, "\n\n")

	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}

	return out, nil
}
