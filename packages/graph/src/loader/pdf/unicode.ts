import type { PageText } from "./types";

export const UNICODE_REPLACEMENT_CHARACTER = "\uFFFD";

export function hasLoneSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0xd800 || code > 0xdfff) {
            continue;
        }

        if (code <= 0xdbff) {
            const next = index + 1 < value.length ? value.charCodeAt(index + 1) : null;
            if (next !== null && next >= 0xdc00 && next <= 0xdfff) {
                index += 1;
                continue;
            }
            return true;
        }

        return true;
    }

    return false;
}

export function repairLoneSurrogates(value: string): string {
    let repaired: string | null = null;

    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0xd800 || code > 0xdfff) {
            if (repaired !== null) {
                repaired += value[index];
            }
            continue;
        }

        if (code <= 0xdbff) {
            const next = index + 1 < value.length ? value.charCodeAt(index + 1) : null;
            if (next !== null && next >= 0xdc00 && next <= 0xdfff) {
                if (repaired !== null) {
                    repaired += value[index]! + value[index + 1]!;
                }
                index += 1;
                continue;
            }
        }

        repaired ??= value.slice(0, index);
        repaired += UNICODE_REPLACEMENT_CHARACTER;
    }

    return repaired ?? value;
}

export function repairPageTextLoneSurrogates(pageText: PageText): PageText {
    let changed = false;
    const text = repairLoneSurrogates(pageText.text);
    const lines = pageText.lines.map((line) => {
        let lineChanged = false;
        const lineText = repairLoneSurrogates(line.text);
        const spans = line.spans.map((span) => {
            let spanChanged = false;
            const spanText = repairLoneSurrogates(span.text);
            const chars = span.chars.map((char) => {
                const repaired = repairLoneSurrogates(char.char);
                if (repaired === char.char) {
                    return char;
                }

                spanChanged = true;
                return { ...char, char: repaired };
            });

            if (spanText !== span.text || spanChanged) {
                lineChanged = true;
                return { ...span, text: spanText, chars };
            }

            return span;
        });

        if (lineText !== line.text || lineChanged) {
            changed = true;
            return { ...line, text: lineText, spans };
        }

        return line;
    });

    if (text !== pageText.text) {
        changed = true;
    }

    return changed ? { ...pageText, text, lines } : pageText;
}
