package ai

import (
	"regexp"
	"strings"
)

// metadataTagPatterns defines the tags that should be stripped from document content
// Uses <doc-*> prefix to avoid conflicts with HTML tags
var metadataTagPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?s)<doc-header>.*?</doc-header>`),
	regexp.MustCompile(`(?s)<doc-footer>.*?</doc-footer>`),
	regexp.MustCompile(`(?s)<doc-signature>.*?</doc-signature>`),
}

// extractFirstTagPatterns - compiled patterns to find the FIRST occurrence of each tag
// Uses <doc-*> prefix to avoid conflicts with HTML tags
var extractFirstTagPatterns = map[string]*regexp.Regexp{
	"header":    regexp.MustCompile(`(?s)<doc-header>(.*?)</doc-header>`),
	"footer":    regexp.MustCompile(`(?s)<doc-footer>(.*?)</doc-footer>`),
	"signature": regexp.MustCompile(`(?s)<doc-signature>(.*?)</doc-signature>`),
}

// excessiveNewlines matches 3 or more consecutive newlines
var excessiveNewlines = regexp.MustCompile(`\n{3,}`)

// DocumentSections holds the parsed sections from a document
type DocumentSections struct {
	Header    string
	Footer    string
	Signature string
}

// StripMetadataTags removes <doc-header>, <doc-footer>, and <doc-signature> tags
// and their contents from the document text.
func StripMetadataTags(content string) string {
	result := content
	for _, pattern := range metadataTagPatterns {
		result = pattern.ReplaceAllString(result, "")
	}
	result = excessiveNewlines.ReplaceAllString(result, "\n\n")
	return strings.TrimSpace(result)
}

// ExtractFirstTagContent extracts content from the first occurrence of a tag.
// Returns empty string if tag not found. Limits output to maxWords.
func ExtractFirstTagContent(content, tagName string, maxWords int) string {
	pattern, ok := extractFirstTagPatterns[tagName]
	if !ok {
		return ""
	}

	match := pattern.FindStringSubmatch(content)
	if len(match) < 2 {
		return ""
	}

	extracted := strings.TrimSpace(match[1])
	return ExtractFirstNWords(extracted, maxWords)
}

// ExtractDocumentSections extracts header, footer, and signature from content.
// Each section is limited to 200 words.
func ExtractDocumentSections(content string) DocumentSections {
	return DocumentSections{
		Header:    ExtractFirstTagContent(content, "header", 200),
		Footer:    ExtractFirstTagContent(content, "footer", 200),
		Signature: ExtractFirstTagContent(content, "signature", 200),
	}
}

// ExtractFirstNWords returns the first N words from content.
// If content has fewer words, returns entire content.
func ExtractFirstNWords(content string, n int) string {
	words := strings.Fields(content)
	if len(words) <= n {
		return content
	}
	return strings.Join(words[:n], " ")
}
