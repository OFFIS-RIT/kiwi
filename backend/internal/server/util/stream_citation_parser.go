package util

import "strings"

type StreamCitationParser struct {
	buffer string
}

func (p *StreamCitationParser) Consume(
	chunk string,
	onContent func(string) error,
	onCitation func(string) error,
) error {
	p.buffer += chunk

	emitContent := func(content string) error {
		if content == "" {
			return nil
		}
		return onContent(content)
	}

	for {
		start := strings.Index(p.buffer, "[[")
		if start == -1 {
			if strings.HasSuffix(p.buffer, "[") {
				if err := emitContent(p.buffer[:len(p.buffer)-1]); err != nil {
					return err
				}
				p.buffer = "["
				return nil
			}

			if err := emitContent(p.buffer); err != nil {
				return err
			}
			p.buffer = ""
			return nil
		}

		if start > 0 {
			if err := emitContent(p.buffer[:start]); err != nil {
				return err
			}
			p.buffer = p.buffer[start:]
		}

		end := strings.Index(p.buffer[2:], "]]")
		if end == -1 {
			return nil
		}
		end += 2

		citationID := p.buffer[2:end]
		if isCitationID(citationID) {
			if err := onCitation(citationID); err != nil {
				return err
			}
			p.buffer = p.buffer[end+2:]
			continue
		}

		if err := emitContent(p.buffer[:1]); err != nil {
			return err
		}
		p.buffer = p.buffer[1:]
	}
}

func (p *StreamCitationParser) Flush(onContent func(string) error) error {
	if p.buffer == "" {
		return nil
	}

	if err := onContent(p.buffer); err != nil {
		return err
	}

	p.buffer = ""
	return nil
}

func isCitationID(id string) bool {
	if id == "" {
		return false
	}

	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}

	return true
}
