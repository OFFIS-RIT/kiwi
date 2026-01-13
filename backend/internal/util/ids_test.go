package util

import (
	"testing"
)

const (
	id1 = "sGvgBXbBcVCjBIKCLS2Os"
	id2 = "tHwhCYcCdWDkCJLDMT3Pt"
	id3 = "uIxiDZdDeXElDKMENUaPu"
)

func TestIsNanoid(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"Valid21Chars", id1, true},
		{"Valid21CharsAlt", id2, true},
		{"TooShort", "abc123", false},
		{"TooLong", "sGvgBXbBcVCjBIKCLS2OsX", false},
		{"WithSpace", "sGvgBXbBcVCjBIKCL 2Os", false},
		{"WithComma", "sGvgBXbBcVCjBIKCL,2Os", false},
		{"Empty", "", false},
		{"AllDashes", "---------------------", true},
		{"AllUnderscores", "_____________________", true},
		{"MixedValid", "Aa0_-Bb1_-Cc2_-Dd3_-E", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isNanoid(tc.in)
			if got != tc.want {
				t.Fatalf("isNanoid(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestExtractNanoid(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"JustNanoid", id1, id1},
		{"PrefixComma", "LEHR," + id1, id1},
		{"MultiplePrefixes", "LEHR,TIGER," + id1, id1},
		{"PrefixSemicolon", "PREFIX;" + id1, id1},
		{"PrefixPipe", "TYPE|" + id1, id1},
		{"PrefixColon", "DOC:" + id1, id1},
		{"MixedSeparators", "A,B;C|" + id1, id1},
		{"TooShort", "abc123", ""},
		{"NoValidNanoid", "LEHR,TIGER,SHORT", ""},
		{"SpacePrefix", "PREFIX " + id1, id1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := extractNanoid(tc.in)
			if got != tc.want {
				t.Fatalf("extractNanoid(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalizeIDs(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "AlreadyOK",
			in:   "Already OK: [[" + id1 + "]]",
			want: "Already OK: [[" + id1 + "]]",
		},
		{
			name: "SingleBracket",
			in:   "Single: [" + id1 + "]",
			want: "Single: [[" + id1 + "]]",
		},
		{
			name: "BoldSingle",
			in:   "Bold single: **[" + id1 + "]**",
			want: "Bold single: [[" + id1 + "]]",
		},
		{
			name: "BoldDouble",
			in:   "Bold double: **[[" + id1 + "]]**",
			want: "Bold double: [[" + id1 + "]]",
		},
		{
			name: "LinkSkipped",
			in:   "Link: [text](http://example.com) and [" + id1 + "]",
			want: "Link: [text](http://example.com) and [[" + id1 + "]]",
		},
		{
			name: "DedupWhitespace",
			in:   "Dupes: [[" + id1 + "]] [[" + id1 + "]] then text",
			want: "Dupes: [[" + id1 + "]] then text",
		},
		{
			name: "DedupTight",
			in:   "Tight dupes: [[" + id1 + "]][[" + id1 + "]] next",
			want: "Tight dupes: [[" + id1 + "]] next",
		},
		{
			name: "DedupAcrossLines",
			in:   "Across lines:\n[[" + id1 + "]]\n[[" + id1 + "]] next",
			want: "Across lines:\n[[" + id1 + "]] next",
		},
		{
			name: "Mixed",
			in:   "Mixed: start [" + id1 + "] and [[" + id2 + "]] and **[" + id3 + "]** and [[" + id3 + "]] [[" + id3 + "]]",
			want: "Mixed: start [[" + id1 + "]] and [[" + id2 + "]] and [[" + id3 + "]] and [[" + id3 + "]]",
		},
		{
			name: "NestedSingleBracketKept",
			in:   "Keep nested: [a[b]c]",
			want: "Keep nested: [a[b]c]",
		},
		{
			name: "DanglingBracket",
			in:   "Dangling: [" + id1,
			want: "Dangling: [" + id1,
		},
		{
			name: "PunctuationAfterSingleBracket",
			in:   "Comma: [" + id1 + "],",
			want: "Comma: [[" + id1 + "]],",
		},
		{
			name: "RunOfDuplicatesWithWhitespace",
			in:   "Run: [[" + id1 + "]]  \t [[" + id1 + "]]   [[" + id1 + "]] end",
			want: "Run: [[" + id1 + "]] end",
		},
		{
			name: "BoldSpaced",
			in:   "Bold spaced: **  [[" + id2 + "]]  **",
			want: "Bold spaced: [[" + id2 + "]]",
		},
		{
			name: "NotDedupAcrossPunctuation",
			in:   "Comma separated: [[" + id1 + "]], [[" + id1 + "]]",
			want: "Comma separated: [[" + id1 + "]], [[" + id1 + "]]",
		},
		{
			name: "LeaveDoubleBracketThenParen",
			in:   "Token then paren: [[" + id1 + "]](x)",
			want: "Token then paren: [[" + id1 + "]](x)",
		},
		{
			name: "MultiSentences_Ellipses",
			in:   ".... [" + id1 + "] [[" + id1 + "]]. ... [" + id1 + "] [[" + id2 + "]]",
			want: ".... [[" + id1 + "]]. ... [[" + id1 + "]] [[" + id2 + "]]",
		},
		{
			name: "MultiSentences_VariousPunct",
			in:   "Start: [" + id1 + "] [[" + id1 + "]]! Next? [" + id1 + "] [[" + id1 + "]]...",
			want: "Start: [[" + id1 + "]]! Next? [[" + id1 + "]]...",
		},
		{
			name: "MultiLine_AdjacentDupesCollapse",
			in:   "Line1: [" + id1 + "] [[" + id1 + "]]\nLine2: [" + id1 + "] [[" + id2 + "]]",
			want: "Line1: [[" + id1 + "]]\nLine2: [[" + id1 + "]] [[" + id2 + "]]",
		},
		{
			name: "MultiLine_DupeAcrossNewlineWhitespace",
			in:   "First:\n[" + id1 + "]\n[[" + id1 + "]] next",
			want: "First:\n[[" + id1 + "]] next",
		},
		{
			name: "MultiLine_DupeAcrossNewlineIndented",
			in:   "First:\n[" + id1 + "]\n    [[" + id1 + "]] next",
			want: "First:\n[[" + id1 + "]] next",
		},
		{
			name: "MultiParagraphs",
			in:   "Intro\n[" + id1 + "] [[" + id1 + "]]\n\nPara 2\n[" + id1 + "] [[" + id2 + "]]",
			want: "Intro\n[[" + id1 + "]]\n\nPara 2\n[[" + id1 + "]] [[" + id2 + "]]",
		},
		{
			name: "NoDedupAcrossPunctuation_Sentences",
			in:   "[[" + id1 + "]]. [[" + id1 + "]] next",
			want: "[[" + id1 + "]]. [[" + id1 + "]] next",
		},
		{
			name: "NoDedupAcrossComma",
			in:   "[[" + id1 + "]], [[" + id1 + "]] next",
			want: "[[" + id1 + "]], [[" + id1 + "]] next",
		},
		{
			name: "TrailingPunctAfterDedup",
			in:   "See: [" + id1 + "] [[" + id1 + "]], then more.",
			want: "See: [[" + id1 + "]], then more.",
		},
		{
			name: "MixedSpacesTabsNewlines",
			in:   "A: [" + id1 + "]\t [[" + id1 + "]] \n[" + id1 + "]\t[[" + id2 + "]]",
			want: "A: [[" + id1 + "]] \n[[" + id1 + "]] [[" + id2 + "]]",
		},
		{
			name: "SentenceBoundariesMultiple",
			in:   "One. [" + id1 + "] [[" + id1 + "]]. Two. [" + id1 + "] [[" + id2 + "]].",
			want: "One. [[" + id1 + "]]. Two. [[" + id1 + "]] [[" + id2 + "]].",
		},
		// Malformed IDs with prefixes from LLM
		{
			name: "MalformedCommaPrefix",
			in:   "Reference: [[LEHR," + id1 + "]]",
			want: "Reference: [[" + id1 + "]]",
		},
		{
			name: "MalformedMultipleCommaPrefixes",
			in:   "Reference: [[LEHR,TIGER," + id1 + "]]",
			want: "Reference: [[" + id1 + "]]",
		},
		{
			name: "MalformedSemicolonPrefix",
			in:   "Reference: [[PREFIX;" + id1 + "]]",
			want: "Reference: [[" + id1 + "]]",
		},
		{
			name: "MalformedPipePrefix",
			in:   "Reference: [[TYPE|" + id1 + "]]",
			want: "Reference: [[" + id1 + "]]",
		},
		{
			name: "MalformedColonPrefix",
			in:   "Reference: [[DOC:" + id1 + "]]",
			want: "Reference: [[" + id1 + "]]",
		},
		{
			name: "MalformedMixedSeparators",
			in:   "Reference: [[A,B;C|" + id1 + "]]",
			want: "Reference: [[" + id1 + "]]",
		},
		{
			name: "MalformedWithSpacePrefix",
			in:   "Reference: [[PREFIX " + id1 + "]]",
			want: "Reference: [[" + id1 + "]]",
		},
		{
			name: "MalformedMultipleIDs",
			in:   "See [[LEHR," + id1 + "]] and [[TIGER," + id2 + "]]",
			want: "See [[" + id1 + "]] and [[" + id2 + "]]",
		},
		{
			name: "ValidIDNoChange",
			in:   "Valid: [[" + id1 + "]]",
			want: "Valid: [[" + id1 + "]]",
		},
		{
			name: "MalformedNoValidNanoid",
			in:   "Invalid: [[LEHR,SHORT]]",
			want: "Invalid: [[LEHR,SHORT]]",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeIDs(tc.in)
			if got != tc.want {
				t.Fatalf("NormalizeIDs(%q)\nwant: %q\ngot:  %q",
					tc.in, tc.want, got)
			}
			twice := NormalizeIDs(got)
			if twice != got {
				t.Fatalf("NormalizeIDs not idempotent for %q:\nfirst:  %q\nsecond: %q",
					tc.in, got, twice)
			}
		})
	}
}
