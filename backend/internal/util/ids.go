package util

import (
	"regexp"
	"strings"
	"unicode"
)

const nanoidLen = 21

var (
	reBoldDouble = regexp.MustCompile(`\*\*\s*\[\[([^][]+)\]\]\s*\*\*`)
	reBoldSingle = regexp.MustCompile(`\*\*\s*\[([^][]+)\]\s*\*\*`)
	reToken      = regexp.MustCompile(`\[\[([^][]+)\]\]`)
	reTokenSep   = regexp.MustCompile(`\]\][\t ]+\[\[`)
	reMalformed  = regexp.MustCompile(`\[\[[^][]{22,}\]\]`)
)

func NormalizeIDs(s string) string {
	s = reBoldDouble.ReplaceAllString(s, "[[$1]]")
	s = reBoldSingle.ReplaceAllString(s, "[$1]")

	s = upgradeSingleBracketsSkippingLinks(s)
	s = dedupeAdjacentIDs(s)
	s = extractLastIDSegment(s)

	s = reTokenSep.ReplaceAllString(s, "]] [[")

	return s
}

func isNanoidChar(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
		(c >= '0' && c <= '9') || c == '_' || c == '-'
}

func isNanoid(s string) bool {
	if len(s) != nanoidLen {
		return false
	}
	for i := range nanoidLen {
		if !isNanoidChar(s[i]) {
			return false
		}
	}
	return true
}

func extractNanoid(s string) string {
	if len(s) < nanoidLen {
		return ""
	}
	for i := len(s) - nanoidLen; i >= 0; i-- {
		candidate := s[i : i+nanoidLen]
		if isNanoid(candidate) {
			if i == 0 || !isNanoidChar(s[i-1]) {
				return candidate
			}
		}
	}
	return ""
}

func extractLastIDSegment(s string) string {
	return reMalformed.ReplaceAllStringFunc(s, func(match string) string {
		inner := match[2 : len(match)-2]
		if isNanoid(inner) {
			return match
		}
		if id := extractNanoid(inner); id != "" {
			return "[[" + id + "]]"
		}
		return match
	})
}

func upgradeSingleBracketsSkippingLinks(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] != '[' {
			b.WriteByte(s[i])
			i++
			continue
		}
		if i+1 < len(s) && s[i+1] == '[' {
			b.WriteString("[[")
			i += 2
			continue
		}
		j := i + 1
		hasInnerBracket := false
		for j < len(s) && s[j] != ']' {
			if s[j] == '[' {
				hasInnerBracket = true
			}
			j++
		}
		if j >= len(s) {
			b.WriteByte(s[i])
			i++
			continue
		}

		if j+1 < len(s) && s[j+1] == '(' {
			b.WriteString(s[i : j+1])
			i = j + 1
			continue
		}
		if hasInnerBracket {
			b.WriteString(s[i : j+1])
			i = j + 1
			continue
		}
		b.WriteString("[[")
		b.WriteString(s[i+1 : j])
		b.WriteString("]]")
		if j+1 < len(s) && s[j+1] == ']' {
			i = j + 2
			continue
		}
		i = j + 1
	}
	return b.String()
}

func dedupeAdjacentIDs(s string) string {
	matches := reToken.FindAllStringSubmatchIndex(s, -1)
	if len(matches) == 0 {
		return s
	}

	var b strings.Builder
	b.Grow(len(s))
	cursor := 0

	for mi := 0; mi < len(matches); mi++ {
		m := matches[mi]
		start, end := m[0], m[1]
		id := s[m[2]:m[3]]

		b.WriteString(s[cursor:start])

		dupEnd := end
		next := mi + 1
		initialAtLineStart := isLineStart(s, start)

		for next < len(matches) {
			nextStart := matches[next][0]
			sep := s[dupEnd:nextStart]

			if !onlyWhitespace(sep) {
				break
			}
			if containsLineBreak(sep) && !initialAtLineStart {
				break
			}

			nextID := s[matches[next][2]:matches[next][3]]
			if nextID != id {
				break
			}
			dupEnd = matches[next][1]
			next++
		}

		b.WriteString(s[start:end])

		cursor = dupEnd
		mi = next - 1
	}

	if cursor < len(s) {
		b.WriteString(s[cursor:])
	}
	return b.String()
}

func onlyWhitespace(s string) bool {
	for _, r := range s {
		if !unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

func containsLineBreak(s string) bool {
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\n', '\r':
			return true
		}
	}
	return false
}

func isLineStart(s string, idx int) bool {
	if idx <= 0 {
		return true
	}
	prev := s[idx-1]
	return prev == '\n' || prev == '\r'
}
