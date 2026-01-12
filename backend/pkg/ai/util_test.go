package ai

import (
	"testing"
)

func TestUnmarshalFlexible_ObjectVariants(t *testing.T) {
	type person struct {
		Name string `json:"name"`
		Age  int    `json:"age,omitempty"`
	}

	tests := []struct {
		name  string
		input string
		want  person
	}{
		{
			name:  "valid json object",
			input: `{"name":"John"}`,
			want:  person{Name: "John"},
		},
		{
			name:  "unquoted key and single quotes",
			input: `{name: 'John'}`,
			want:  person{Name: "John"},
		},
		{
			name:  "trailing comma",
			input: `{"name":"John",}`,
			want:  person{Name: "John"},
		},
		{
			name:  "missing endbracket",
			input: `{"name":"John`,
			want:  person{Name: "John"},
		},
		{
			name:  "stringified invalid json object",
			input: `"{name: 'John'}"`,
			want:  person{Name: "John"},
		},
		{
			name:  "duplicate leading brace",
			input: "{\n{\n  \"name\": \"John\"\n}\n",
			want:  person{Name: "John"},
		},
		{
			name:  "duplicate leading brace no newlines",
			input: `{ { "name": "John" }`,
			want:  person{Name: "John"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got person
			if err := UnmarshalFlexible(tc.input, &got); err != nil {
				t.Fatalf("UnmarshalFlexible() error = %v", err)
			}
			if got.Name != tc.want.Name || got.Age != tc.want.Age {
				t.Fatalf("UnmarshalFlexible() got = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestUnmarshalFlexible_ArrayVariants(t *testing.T) {
	type person struct {
		Name string `json:"name"`
		Age  int    `json:"age,omitempty"`
	}

	input := `[{name:'A'},{name:'B',}]`
	var got []person
	if err := UnmarshalFlexible(input, &got); err != nil {
		t.Fatalf("UnmarshalFlexible() error = %v", err)
	}
	if len(got) != 2 || got[0].Name != "A" || got[1].Name != "B" {
		t.Fatalf("UnmarshalFlexible() got = %+v, want two persons A,B", got)
	}
}

func TestUnmarshalFlexible_Unrecoverable(t *testing.T) {
	type person struct {
		Name string `json:"name"`
		Age  int    `json:"age,omitempty"`
	}

	var got person
	if err := UnmarshalFlexible("hello", &got); err == nil {
		t.Fatalf("UnmarshalFlexible() expected error for unrecoverable input")
	}
}

func TestUnmarshalFlexible_CountryExamples(t *testing.T) {
	type country struct {
		Name      string   `json:"name"`
		Capital   string   `json:"capital"`
		Languages []string `json:"languages"`
	}

	tests := []struct {
		name  string
		input string
		want  country
	}{
		{
			name:  "canada simple stringified",
			input: `"{ \"name\": \"Canada\", \"capital\": \"Ottawa\", \"languages\": [ \"English\", \"French\" ] }"`,
			want:  country{Name: "Canada", Capital: "Ottawa", Languages: []string{"English", "French"}},
		},
		{
			name:  "canada stringified with newlines",
			input: `"{\n  \"name\": \"Canada\",\n  \"capital\": \"Ottawa\",\n  \"languages\": [\"English\", \"French\", \"Other Indigenous Languages (e.g., Cree, Inuktitut)\"]\n  }\n"`,
			want:  country{Name: "Canada", Capital: "Ottawa", Languages: []string{"English", "French", "Other Indigenous Languages (e.g., Cree, Inuktitut)"}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got country
			if err := UnmarshalFlexible(tc.input, &got); err != nil {
				t.Fatalf("UnmarshalFlexible() error = %v", err)
			}
			if got.Name != tc.want.Name || got.Capital != tc.want.Capital {
				t.Fatalf("UnmarshalFlexible() got = %+v, want %+v", got, tc.want)
			}
			if len(got.Languages) != len(tc.want.Languages) {
				t.Fatalf("UnmarshalFlexible() languages length got = %d, want %d", len(got.Languages), len(tc.want.Languages))
			}
			for i := range got.Languages {
				if got.Languages[i] != tc.want.Languages[i] {
					t.Fatalf("UnmarshalFlexible() languages[%d] = %q, want %q", i, got.Languages[i], tc.want.Languages[i])
				}
			}
		})
	}
}
