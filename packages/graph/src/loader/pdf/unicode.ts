import type { PageText } from "./types";

export const UNICODE_REPLACEMENT_CHARACTER = "\uFFFD";
const PRINTABLE_SINGLE_BYTE_START = 0x20;
const PRINTABLE_ASCII_END = 0x7e;
const PRINTABLE_LATIN1_START = 0xa0;
const PRINTABLE_LATIN1_END = 0xff;
const PRINTABLE_WINDOWS_1252_CHARS: Record<number, string> = {
    0x80: "€",
    0x82: "‚",
    0x83: "ƒ",
    0x84: "„",
    0x85: "…",
    0x86: "†",
    0x87: "‡",
    0x88: "ˆ",
    0x89: "‰",
    0x8a: "Š",
    0x8b: "‹",
    0x8c: "Œ",
    0x8e: "Ž",
    0x91: "‘",
    0x92: "’",
    0x93: "“",
    0x94: "”",
    0x95: "•",
    0x96: "–",
    0x97: "—",
    0x98: "˜",
    0x99: "™",
    0x9a: "š",
    0x9b: "›",
    0x9c: "œ",
    0x9e: "ž",
    0x9f: "Ÿ",
};

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

function repairPDFTextEncodingArtifacts(value: string): string {
    const surrogateRepaired = repairLoneSurrogates(value);
    let repaired: string | null = null;

    for (let index = 0; index < surrogateRepaired.length; index += 1) {
        const code = surrogateRepaired.charCodeAt(index);
        const highByte = code >> 8;
        const lowByte = code & 0xff;
        const highByteText = decodePrintableSingleByteText(highByte);
        const lowByteText = decodePrintableSingleByteText(lowByte);
        if (
            code >= 0x3000 &&
            code !== UNICODE_REPLACEMENT_CHARACTER.charCodeAt(0) &&
            (code < 0xd800 || code > 0xdfff) &&
            highByteText !== null &&
            lowByteText !== null
        ) {
            repaired ??= surrogateRepaired.slice(0, index);
            repaired += highByteText + lowByteText;
            continue;
        }

        if (repaired !== null) {
            repaired += surrogateRepaired[index];
        }
    }

    return repaired ?? surrogateRepaired;
}

function decodePrintableSingleByteText(byte: number): string | null {
    if (
        (byte >= PRINTABLE_SINGLE_BYTE_START && byte <= PRINTABLE_ASCII_END) ||
        (byte >= PRINTABLE_LATIN1_START && byte <= PRINTABLE_LATIN1_END)
    ) {
        return String.fromCharCode(byte);
    }

    return PRINTABLE_WINDOWS_1252_CHARS[byte] ?? null;
}

export function repairPageTextLoneSurrogates(pageText: PageText): PageText {
    let changed = false;
    const text = repairPDFTextEncodingArtifacts(pageText.text);
    const lines = pageText.lines.map((line) => {
        let lineChanged = false;
        const lineText = repairPDFTextEncodingArtifacts(line.text);
        const spans = line.spans.map((span) => {
            let spanChanged = false;
            const spanText = repairPDFTextEncodingArtifacts(span.text);
            const chars = span.chars.map((char) => {
                const repaired = repairPDFTextEncodingArtifacts(char.char);
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
