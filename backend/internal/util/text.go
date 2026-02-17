package util

import "strings"

func SanitizePostgresText(value string) string {
	if value == "" {
		return value
	}

	sanitized := strings.ToValidUTF8(value, "")
	return strings.ReplaceAll(sanitized, "\x00", "")
}
