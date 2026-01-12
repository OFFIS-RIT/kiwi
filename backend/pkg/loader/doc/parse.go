package doc

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"
	"strings"
)

func parseDocx(content []byte) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return nil, fmt.Errorf("failed to open docx: %w", err)
	}

	var docFile *zip.File
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			docFile = f
			break
		}
	}
	if docFile == nil {
		return nil, fmt.Errorf("document.xml not found in docx")
	}
	if docFile.UncompressedSize64 > docXMLMax {
		return nil, fmt.Errorf("document.xml too large: %d bytes",
			docFile.UncompressedSize64)
	}

	rc, err := docFile.Open()
	if err != nil {
		return nil, fmt.Errorf("failed to open document.xml: %w", err)
	}
	defer rc.Close()

	dec := xml.NewDecoder(io.LimitReader(rc, int64(docXMLMax)))

	var sb strings.Builder
	type state struct {
		inText    bool
		delDepth  int
		insideTbl bool
		cellIdx   int
	}
	st := state{}

	writeNewline := func() {
		if sb.Len() == 0 {
			return
		}
		if !strings.HasSuffix(sb.String(), "\n") {
			sb.WriteByte('\n')
		}
	}

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("failed to parse XML: %w", err)
		}

		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "del":
				st.delDepth++
			case "t":
				st.inText = true
			case "tab":
				if st.delDepth == 0 {
					sb.WriteRune('\t')
				}
			case "br", "cr":
				if st.delDepth == 0 {
					sb.WriteByte('\n')
				}
			case "noBreakHyphen":
				if st.delDepth == 0 {
					sb.WriteRune('-')
				}
			case "softHyphen":
			case "tbl":
				st.insideTbl = true
				st.cellIdx = 0
				writeNewline()
			case "tr":
				st.cellIdx = 0
			case "tc":
				if st.insideTbl && st.delDepth == 0 {
					if st.cellIdx > 0 {
						sb.WriteRune('\t')
					}
					st.cellIdx++
				}
			}

		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				st.inText = false
			case "p":
				if st.delDepth == 0 {
					sb.WriteByte('\n')
				}
			case "tr":
				if st.delDepth == 0 {
					sb.WriteByte('\n')
				}
			case "tbl":
				st.insideTbl = false
				if st.delDepth == 0 {
					sb.WriteByte('\n')
				}
			case "del":
				if st.delDepth > 0 {
					st.delDepth--
				}
			}

		case xml.CharData:
			if st.delDepth != 0 || !st.inText {
				continue
			}
			sb.WriteString(string([]byte(t)))
		}
	}

	text := strings.TrimSpace(sb.String())
	reNewlines := regexp.MustCompile(`\n{3,}`)
	text = reNewlines.ReplaceAllString(text, "\n\n")

	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}

	return []byte(text), nil
}
