package util

import (
	"testing"
)

func TestNormalizeIDs(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "AlreadyOK",
			in:   "Already OK: [[abc-123]]",
			want: "Already OK: [[abc-123]]",
		},
		{
			name: "SingleBracket",
			in:   "Single: [abc-123]",
			want: "Single: [[abc-123]]",
		},
		{
			name: "BoldSingle",
			in:   "Bold single: **[abc-123]**",
			want: "Bold single: [[abc-123]]",
		},
		{
			name: "BoldDouble",
			in:   "Bold double: **[[abc-123]]**",
			want: "Bold double: [[abc-123]]",
		},
		{
			name: "LinkSkipped",
			in:   "Link: [text](http://example.com) and [abc]",
			want: "Link: [text](http://example.com) and [[abc]]",
		},
		{
			name: "DedupWhitespace",
			in:   "Dupes: [[id 1]] [[id 1]] then text",
			want: "Dupes: [[id 1]] then text",
		},
		{
			name: "DedupTight",
			in:   "Tight dupes: [[id 1]][[id 1]] next",
			want: "Tight dupes: [[id 1]] next",
		},
		{
			name: "DedupAcrossLines",
			in:   "Across lines:\n[[id]]\n[[id]] next",
			want: "Across lines:\n[[id]] next",
		},
		{
			name: "Mixed",
			in:   "Mixed: start [id] and [[ok]] and **[x]** and [[x]] [[x]]",
			want: "Mixed: start [[id]] and [[ok]] and [[x]] and [[x]]",
		},
		{
			name: "NestedSingleBracketKept",
			in:   "Keep nested: [a[b]c]",
			want: "Keep nested: [a[b]c]",
		},
		{
			name: "DanglingBracket",
			in:   "Dangling: [abc",
			want: "Dangling: [abc",
		},
		{
			name: "PunctuationAfterSingleBracket",
			in:   "Comma: [abc],",
			want: "Comma: [[abc]],",
		},
		{
			name: "RunOfDuplicatesWithWhitespace",
			in:   "Run: [[a]]  \t [[a]]   [[a]] end",
			want: "Run: [[a]] end",
		},
		{
			name: "BoldSpaced",
			in:   "Bold spaced: **  [[id 2]]  **",
			want: "Bold spaced: [[id 2]]",
		},
		{
			name: "NotDedupAcrossPunctuation",
			in:   "Comma separated: [[a]], [[a]]",
			want: "Comma separated: [[a]], [[a]]",
		},
		{
			name: "LeaveDoubleBracketThenParen",
			in:   "Token then paren: [[a]](x)",
			want: "Token then paren: [[a]](x)",
		},
		{
			name: "MultiSentences_Ellipses", // your example
			in:   ".... [id] [[id]]. ... [id] [[other id]]",
			want: ".... [[id]]. ... [[id]] [[other id]]",
		},
		{
			name: "MultiSentences_VariousPunct",
			in:   "Start: [id] [[id]]! Next? [id] [[id]]...",
			want: "Start: [[id]]! Next? [[id]]...",
		},
		{
			name: "MultiLine_AdjacentDupesCollapse",
			in:   "Line1: [id] [[id]]\nLine2: [id] [[other id]]",
			want: "Line1: [[id]]\nLine2: [[id]] [[other id]]",
		},
		{
			name: "MultiLine_DupeAcrossNewlineWhitespace",
			in:   "First:\n[id]\n[[id]] next",
			want: "First:\n[[id]] next",
		},
		{
			name: "MultiLine_DupeAcrossNewlineIndented",
			in:   "First:\n[id]\n    [[id]] next",
			want: "First:\n[[id]] next",
		},
		{
			name: "MultiParagraphs",
			in:   "Intro\n[id] [[id]]\n\nPara 2\n[id] [[other id]]",
			want: "Intro\n[[id]]\n\nPara 2\n[[id]] [[other id]]",
		},
		{
			name: "NoDedupAcrossPunctuation_Sentences",
			in:   "[[id]]. [[id]] next",
			want: "[[id]]. [[id]] next",
		},
		{
			name: "NoDedupAcrossComma",
			in:   "[[id]], [[id]] next",
			want: "[[id]], [[id]] next",
		},
		{
			name: "TrailingPunctAfterDedup",
			in:   "See: [id] [[id]], then more.",
			want: "See: [[id]], then more.",
		},
		{
			name: "MixedSpacesTabsNewlines",
			in:   "A: [id]\t [[id]] \n[id]\t[[other id]]",
			want: "A: [[id]] \n[[id]] [[other id]]",
		},
		{
			name: "SentenceBoundariesMultiple",
			in:   "One. [id] [[id]]. Two. [id] [[other id]].",
			want: "One. [[id]]. Two. [[id]] [[other id]].",
		},
		// Malformed IDs with prefixes from LLM
		{
			name: "MalformedCommaPrefix",
			in:   "Reference: [[LEHR,sGvgBXbBcVCjBIKCLS2Os]]",
			want: "Reference: [[sGvgBXbBcVCjBIKCLS2Os]]",
		},
		{
			name: "MalformedMultipleCommaPrefixes",
			in:   "Reference: [[LEHR,TIGER,sGvgBXbBcVCjBIKCLS2Os]]",
			want: "Reference: [[sGvgBXbBcVCjBIKCLS2Os]]",
		},
		{
			name: "MalformedSemicolonPrefix",
			in:   "Reference: [[PREFIX;abc123xyz]]",
			want: "Reference: [[abc123xyz]]",
		},
		{
			name: "MalformedPipePrefix",
			in:   "Reference: [[TYPE|abc123xyz]]",
			want: "Reference: [[abc123xyz]]",
		},
		{
			name: "MalformedColonPrefix",
			in:   "Reference: [[DOC:abc123xyz]]",
			want: "Reference: [[abc123xyz]]",
		},
		{
			name: "MalformedMixedSeparators",
			in:   "Reference: [[A,B;C|abc123xyz]]",
			want: "Reference: [[abc123xyz]]",
		},
		{
			name: "MalformedWithSpaces",
			in:   "Reference: [[PREFIX, abc123xyz ]]",
			want: "Reference: [[abc123xyz]]",
		},
		{
			name: "MalformedMultipleIDs",
			in:   "See [[LEHR,id1]] and [[TIGER,id2]]",
			want: "See [[id1]] and [[id2]]",
		},
		{
			name: "ValidIDNoChange",
			in:   "Valid: [[sGvgBXbBcVCjBIKCLS2Os]]",
			want: "Valid: [[sGvgBXbBcVCjBIKCLS2Os]]",
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
