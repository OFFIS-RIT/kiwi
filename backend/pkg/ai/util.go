package ai

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/invopop/jsonschema"
	"github.com/kaptinlin/jsonrepair"
)

func stripDuplicateLeadingBrace(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "{") {
		rest := strings.TrimSpace(s[1:])
		if strings.HasPrefix(rest, "{") {
			return rest
		}
	}
	return s
}

// GenerateSchema creates a JSON Schema from the given Go type.
// It uses reflection to inspect the type structure and generates
// a schema suitable for use with AI structured output.
func GenerateSchema(value any) any {
	reflector := jsonschema.Reflector{
		AllowAdditionalProperties: false,
		DoNotReference:            true,
	}

	t := reflect.TypeOf(value)
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}

	v := reflect.New(t).Interface()
	return reflector.Reflect(v)
}

// UnmarshalFlexible attempts to unmarshal JSON into the target with multiple fallback strategies.
// It first tries standard JSON unmarshaling, then handles double-encoded JSON strings,
// and finally attempts to repair malformed JSON before parsing.
//
// This is useful for parsing AI-generated JSON which may be malformed or wrapped in strings.
//
// Example:
//
//	var result MyStruct
//	// All of these inputs would work:
//	UnmarshalFlexible(`{"name": "test"}`, &result)           // standard JSON
//	UnmarshalFlexible(`"{\"name\": \"test\"}"`, &result)     // double-encoded
//	UnmarshalFlexible(`{name: "test"}`, &result)             // malformed (repaired)
func UnmarshalFlexible(input string, out any) error {
	input = strings.TrimSpace(input)

	if err := json.Unmarshal([]byte(input), out); err == nil {
		return nil
	}

	var asString string
	if err := json.Unmarshal([]byte(input), &asString); err == nil {
		asString = strings.TrimSpace(asString)
		if err := json.Unmarshal([]byte(asString), out); err == nil {
			return nil
		}
		input = asString
	}

	input = stripDuplicateLeadingBrace(input)
	repaired, err := jsonrepair.JSONRepair(input)
	if err != nil {
		return fmt.Errorf("json repair failed: %w (input: %s)", err, input)
	}

	if err := json.Unmarshal([]byte(repaired), out); err == nil {
		return nil
	}

	return fmt.Errorf(
		"unmarshal failed after repair: input=%s repaired=%s",
		input, repaired,
	)
}
