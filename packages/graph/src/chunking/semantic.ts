import type { GraphChunker } from "..";
import { get_encoding } from "tiktoken";

const MARKDOWN_TABLE_DELIMITER_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const MARKDOWN_HEADING_PATTERN = /^\s{0,3}#{1,6}\s*\S+/;
const COMMON_SENTENCE_ABBREVIATIONS = new Set([
    "bsp.",
    "bzw.",
    "ca.",
    "dipl.",
    "dr.",
    "etc.",
    "evtl.",
    "geb.",
    "ing.",
    "mr.",
    "mrs.",
    "ms.",
    "nr.",
    "prof.",
    "str.",
    "tel.",
    "usw.",
    "vgl.",
]);

const enum SegmentKind {
    Text,
    TableRow,
}

const enum SemanticSplitLevel {
    DoubleEmpty,
    MarkdownHeading,
    Sentence,
}

type Segment = {
    text: string;
    kind: SegmentKind;
    tableHeader: string;
    tableId: number;
};

type TokenEncoder = ReturnType<typeof get_encoding>;

class TokenCounter {
    private readonly cache = new Map<string, number>();

    constructor(private readonly encoder: TokenEncoder) {}

    count(text: string): number {
        const normalized = text.trim();
        if (normalized === "") {
            return 0;
        }

        const cached = this.cache.get(normalized);
        if (cached !== undefined) {
            return cached;
        }

        const tokens = this.encoder.encode(normalized).length;
        this.cache.set(normalized, tokens);
        return tokens;
    }
}

export class SemanticChunker implements GraphChunker {
    constructor(
        private readonly maxChunkSize: number,
        private readonly encoderName = "o200k_base"
    ) {}

    async getChunks(input: string): Promise<string[]> {
        const text = input.trim();
        if (text === "") {
            return [];
        }

        const encoder = get_encoding(this.encoderName as Parameters<typeof get_encoding>[0]);

        try {
            const counter = new TokenCounter(encoder);
            let chunks = chunkTextRecursively(text, counter, this.maxChunkSize, SemanticSplitLevel.DoubleEmpty);
            chunks = mergeTinyChunks(chunks, counter, this.maxChunkSize);

            return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk !== "");
        } finally {
            encoder.free();
        }
    }
}

function chunkTextRecursively(
    text: string,
    counter: TokenCounter,
    maxTokens: number,
    level: SemanticSplitLevel
): string[] {
    const normalized = text.trim();
    if (normalized === "") {
        return [];
    }

    if (maxTokens <= 0) {
        return chunkBySentenceOrTable(normalized, counter, maxTokens);
    }

    if (counter.count(normalized) <= maxTokens) {
        return [normalized];
    }

    if (level >= SemanticSplitLevel.Sentence) {
        return chunkBySentenceOrTable(normalized, counter, maxTokens);
    }

    const parts = splitBySemanticLevel(normalized, level);
    if (parts.length <= 1) {
        return chunkTextRecursively(normalized, counter, maxTokens, level + 1);
    }

    const result: string[] = [];
    let current = "";

    const flushCurrent = () => {
        const value = current.trim();
        if (value !== "") {
            result.push(value);
        }
        current = "";
    };

    for (const rawPart of parts) {
        const part = rawPart.trim();
        if (part === "") {
            continue;
        }

        const subChunks =
            counter.count(part) > maxTokens ? chunkTextRecursively(part, counter, maxTokens, level + 1) : [part];

        for (const rawSubChunk of subChunks) {
            const subChunk = rawSubChunk.trim();
            if (subChunk === "") {
                continue;
            }

            if (current === "") {
                current = subChunk;
                continue;
            }

            const candidate = joinChunkParts(current, subChunk);
            if (counter.count(candidate) <= maxTokens) {
                current = candidate;
                continue;
            }

            flushCurrent();
            current = subChunk;
        }
    }

    flushCurrent();

    if (result.length === 0) {
        return chunkTextRecursively(normalized, counter, maxTokens, level + 1);
    }

    return result;
}

function splitBySemanticLevel(text: string, level: SemanticSplitLevel): string[] {
    switch (level) {
        case SemanticSplitLevel.DoubleEmpty:
            return splitByDoubleEmptyLines(text);
        case SemanticSplitLevel.MarkdownHeading:
            return splitByMarkdownHeadings(text);
        default:
            return [text];
    }
}

function chunkBySentenceOrTable(text: string, counter: TokenCounter, maxTokens: number): string[] {
    const segments = splitIntoSegments(text);
    if (segments.length === 0) {
        return [];
    }

    if (maxTokens <= 0) {
        return segments
            .map((_, index) => buildChunkText(segments, index, index + 1).trim())
            .filter((chunk) => chunk !== "");
    }

    const chunks: string[] = [];
    let chunkStart = -1;
    let chunkEnd = -1;

    const flushChunk = () => {
        if (chunkStart < 0 || chunkEnd <= chunkStart) {
            return;
        }

        const chunkText = buildChunkText(segments, chunkStart, chunkEnd).trim();
        if (chunkText !== "") {
            chunks.push(chunkText);
        }

        chunkStart = -1;
        chunkEnd = -1;
    };

    for (let index = 0; index < segments.length; index += 1) {
        if (chunkStart < 0) {
            chunkStart = index;
            chunkEnd = index + 1;
            continue;
        }

        const candidate = buildChunkText(segments, chunkStart, index + 1);
        if (counter.count(candidate) <= maxTokens) {
            chunkEnd = index + 1;
            continue;
        }

        flushChunk();
        chunkStart = index;
        chunkEnd = index + 1;
    }

    flushChunk();
    return chunks;
}

function mergeTinyChunks(input: string[], counter: TokenCounter, maxTokens: number): string[] {
    if (input.length <= 1 || maxTokens <= 0) {
        return input;
    }

    const chunks = [...input];
    const minTokens = Math.max(Math.ceil(maxTokens * 0.05), 1);

    for (let index = 0; index < chunks.length; ) {
        const currentChunk = chunks[index]!;
        chunks[index] = currentChunk.trim();
        if (chunks[index] === "") {
            chunks.splice(index, 1);
            continue;
        }

        if (counter.count(chunks[index]!) > minTokens || chunks.length === 1) {
            index += 1;
            continue;
        }

        if (index === 0) {
            chunks[1] = joinChunkParts(chunks[0]!, chunks[1]!);
            chunks.splice(0, 1);
            continue;
        }

        chunks[index - 1] = joinChunkParts(chunks[index - 1]!, chunks[index]!);
        chunks.splice(index, 1);
        index = Math.max(index - 1, 0);
    }

    return chunks;
}

function joinChunkParts(left: string, right: string): string {
    const normalizedLeft = left.trim();
    const normalizedRight = right.trim();

    if (normalizedLeft === "") {
        return normalizedRight;
    }
    if (normalizedRight === "") {
        return normalizedLeft;
    }

    return `${normalizedLeft}\n\n${normalizedRight}`;
}

function splitByDoubleEmptyLines(text: string): string[] {
    const lines = text.split("\n");
    const parts: string[] = [];
    let current: string[] = [];
    let emptyRun = 0;

    const flushCurrent = () => {
        if (current.length === 0) {
            return;
        }

        const part = current.join("\n").trim();
        if (part !== "") {
            parts.push(part);
        }
        current = [];
    };

    for (const rawLine of lines) {
        const line = trimRightCarriageReturn(rawLine);
        if (isEmptyLine(line)) {
            emptyRun += 1;
            if (emptyRun >= 2) {
                flushCurrent();
            }
            continue;
        }

        if (emptyRun === 1) {
            current.push("");
        }

        emptyRun = 0;
        current.push(line);
    }

    flushCurrent();

    if (parts.length === 0) {
        return text.trim() === "" ? [] : [text.trim()];
    }

    return parts;
}

function splitByMarkdownHeadings(text: string): string[] {
    const lines = text.split("\n");
    const parts: string[] = [];
    let current: string[] = [];
    let hasHeading = false;

    const flushCurrent = () => {
        if (current.length === 0) {
            return;
        }

        const part = current.join("\n").trim();
        if (part !== "") {
            parts.push(part);
        }
        current = [];
    };

    for (const rawLine of lines) {
        const line = trimRightCarriageReturn(rawLine);
        if (MARKDOWN_HEADING_PATTERN.test(line)) {
            hasHeading = true;
            flushCurrent();
            current.push(line);
            continue;
        }

        current.push(line);
    }

    flushCurrent();

    if (!hasHeading) {
        return text.trim() === "" ? [] : [text.trim()];
    }

    return parts;
}

function splitIntoSegments(text: string): Segment[] {
    const lines = text.split("\n");
    const segments: Segment[] = [];
    let currentSentence = "";

    const appendSentence = () => {
        const value = currentSentence.trim();
        if (value === "") {
            return;
        }

        segments.push({
            text: value,
            kind: SegmentKind.Text,
            tableHeader: "",
            tableId: 0,
        });
        currentSentence = "";
    };

    const isTableRow = (line: string) => {
        const trimmed = line.trim();
        return trimmed !== "" && trimmed.includes("|");
    };

    let inTable = false;
    let tableId = 0;
    let tableHeader = "";
    let tableHasRows = false;

    for (let index = 0; index < lines.length; index += 1) {
        const line = trimRightCarriageReturn(lines[index]!);
        const trimmed = line.trim();

        if (
            !inTable &&
            isTableRow(line) &&
            index + 1 < lines.length &&
            MARKDOWN_TABLE_DELIMITER_PATTERN.test(lines[index + 1]!.trim())
        ) {
            appendSentence();
            inTable = true;
            tableId += 1;
            tableHeader = `${line}\n${trimRightCarriageReturn(lines[index + 1]!)}`;
            tableHasRows = false;
            index += 1;
            continue;
        }

        if (inTable) {
            if (trimmed === "" || !isTableRow(line)) {
                if (!tableHasRows && tableHeader !== "") {
                    segments.push({
                        text: tableHeader,
                        kind: SegmentKind.Text,
                        tableHeader: "",
                        tableId: 0,
                    });
                }

                inTable = false;
                tableHeader = "";
                tableHasRows = false;

                if (trimmed === "") {
                    appendSentence();
                    continue;
                }

                for (const sentence of splitLineIntoSentences(trimmed)) {
                    currentSentence = currentSentence === "" ? sentence : `${currentSentence} ${sentence}`;

                    if (endsWithSentenceTerminator(sentence)) {
                        appendSentence();
                    }
                }
                continue;
            }

            segments.push({
                text: line,
                kind: SegmentKind.TableRow,
                tableHeader,
                tableId,
            });
            tableHasRows = true;
            continue;
        }

        if (!inTable && isTableRow(line)) {
            appendSentence();
            if (trimmed !== "") {
                segments.push({
                    text: trimmed,
                    kind: SegmentKind.Text,
                    tableHeader: "",
                    tableId: 0,
                });
            }
            continue;
        }

        if (trimmed === "") {
            appendSentence();
            continue;
        }

        for (const sentence of splitLineIntoSentences(trimmed)) {
            currentSentence = currentSentence === "" ? sentence : `${currentSentence} ${sentence}`;

            if (endsWithSentenceTerminator(sentence)) {
                appendSentence();
            }
        }
    }

    if (inTable && !tableHasRows && tableHeader !== "") {
        segments.push({
            text: tableHeader,
            kind: SegmentKind.Text,
            tableHeader: "",
            tableId: 0,
        });
    }

    appendSentence();

    return segments.filter((segment) => segment.text.trim() !== "");
}

function buildChunkText(segments: Segment[], start: number, end: number): string {
    let chunkText = "";
    let currentTableId = -1;
    let lastKind = SegmentKind.Text;
    let hasContent = false;

    for (let index = start; index < end; index += 1) {
        const segment = segments[index]!;

        if (segment.kind === SegmentKind.TableRow && segment.tableHeader !== "" && segment.tableId !== currentTableId) {
            chunkText += hasContent
                ? `\n${segment.tableHeader}\n${segment.text}`
                : `${segment.tableHeader}\n${segment.text}`;
            hasContent = true;
            currentTableId = segment.tableId;
            lastKind = SegmentKind.TableRow;
            continue;
        }

        if (hasContent) {
            if (segment.kind === SegmentKind.TableRow) {
                chunkText += "\n";
            } else if (lastKind === SegmentKind.TableRow) {
                chunkText += "\n";
            } else {
                chunkText += " ";
            }
        }

        chunkText += segment.text;
        hasContent = true;

        if (segment.kind === SegmentKind.TableRow) {
            currentTableId = segment.tableId;
            lastKind = SegmentKind.TableRow;
        } else {
            currentTableId = -1;
            lastKind = SegmentKind.Text;
        }
    }

    return chunkText;
}

function splitLineIntoSentences(line: string): string[] {
    const chars = Array.from(line);
    if (chars.length === 0) {
        return [];
    }

    const sentences: string[] = [];
    let start = 0;

    const flush = (end: number) => {
        if (end <= start) {
            return;
        }

        const sentence = chars.slice(start, end).join("").trim();
        if (sentence !== "") {
            sentences.push(sentence);
        }
        start = end;
    };

    for (let index = 0; index < chars.length; index += 1) {
        if (!isSentenceBoundaryAtIndex(chars, index)) {
            continue;
        }

        let end = index + 1;
        while (end < chars.length && (chars[end]! === "." || chars[end]! === "!" || chars[end]! === "?")) {
            end += 1;
        }
        while (end < chars.length && isSentenceClosingChar(chars[end]!)) {
            end += 1;
        }

        flush(end);
        index = end - 1;
    }

    flush(chars.length);
    return sentences;
}

function endsWithSentenceTerminator(sentence: string): boolean {
    const trimmed = sentence.trim();
    if (trimmed === "") {
        return false;
    }

    const chars = Array.from(trimmed);
    let index = chars.length - 1;
    while (index >= 0 && isSentenceClosingChar(chars[index]!)) {
        index -= 1;
    }

    if (index < 0) {
        return false;
    }

    return chars[index]! === "." || chars[index]! === "!" || chars[index]! === "?";
}

function isSentenceBoundaryAtIndex(chars: string[], index: number): boolean {
    if (index < 0 || index >= chars.length) {
        return false;
    }

    switch (chars[index]!) {
        case "!":
        case "?":
            return true;
        case ".":
            if (isDateOrDecimalDot(chars, index)) {
                return false;
            }
            if (isNumericListingDot(chars, index)) {
                return false;
            }
            if (isAbbreviationDot(chars, index)) {
                return false;
            }
            return true;
        default:
            return false;
    }
}

function isDateOrDecimalDot(chars: string[], dotIndex: number): boolean {
    const previous = previousNonSpaceIndex(chars, dotIndex - 1);
    const next = nextNonSpaceIndex(chars, dotIndex + 1);

    if (previous >= 0 && next >= 0 && isDigit(chars[previous]!) && isDigit(chars[next]!)) {
        return true;
    }

    if (previous < 0 || !isDigit(chars[previous]!)) {
        return false;
    }

    let numberStart = previous;
    while (numberStart >= 0 && isDigit(chars[numberStart]!)) {
        numberStart -= 1;
    }

    const previousDot = previousNonSpaceIndex(chars, numberStart);
    const previousDigit = previousNonSpaceIndex(chars, previousDot - 1);
    return previousDot >= 0 && chars[previousDot]! === "." && previousDigit >= 0 && isDigit(chars[previousDigit]!);
}

function isNumericListingDot(chars: string[], dotIndex: number): boolean {
    const previous = previousNonSpaceIndex(chars, dotIndex - 1);
    const next = nextNonSpaceIndex(chars, dotIndex + 1);

    if (previous < 0 || next < 0) {
        return false;
    }
    if (!isDigit(chars[previous]!) || !isLetter(chars[next]!)) {
        return false;
    }

    if (dotIndex + 1 < chars.length && isSpace(chars[dotIndex + 1]!) && isUpper(chars[next]!)) {
        return true;
    }

    let numberStart = previous;
    while (numberStart >= 0 && isDigit(chars[numberStart]!)) {
        numberStart -= 1;
    }

    const beforeNumber = previousNonSpaceIndex(chars, numberStart);
    if (beforeNumber < 0) {
        return true;
    }

    return [".", ":", ";", "(", "[", "{"].includes(chars[beforeNumber]!);
}

function isAbbreviationDot(chars: string[], dotIndex: number): boolean {
    const previous = previousNonSpaceIndex(chars, dotIndex - 1);
    if (previous < 0 || !isLetter(chars[previous]!)) {
        return false;
    }

    let wordStart = previous;
    while (wordStart >= 0 && (isLetter(chars[wordStart]!) || chars[wordStart]! === "-")) {
        wordStart -= 1;
    }

    const word = chars
        .slice(wordStart + 1, previous + 1)
        .join("")
        .trim()
        .toLowerCase();
    if (word === "") {
        return false;
    }

    if (COMMON_SENTENCE_ABBREVIATIONS.has(`${word}.`)) {
        return true;
    }

    if (Array.from(word).length !== 1) {
        return false;
    }

    const next = nextNonSpaceIndex(chars, dotIndex + 1);
    if (next >= 0 && isLetter(chars[next]!)) {
        const nextDot = nextNonSpaceIndex(chars, next + 1);
        if (nextDot >= 0 && chars[nextDot]! === ".") {
            return true;
        }
    }

    const previousDot = previousNonSpaceIndex(chars, wordStart);
    if (previousDot < 0 || chars[previousDot]! !== ".") {
        return false;
    }

    const previousLetter = previousNonSpaceIndex(chars, previousDot - 1);
    if (previousLetter < 0 || !isLetter(chars[previousLetter]!)) {
        return false;
    }

    let previousWordStart = previousLetter;
    while (previousWordStart >= 0 && isLetter(chars[previousWordStart]!)) {
        previousWordStart -= 1;
    }

    if (previousLetter - previousWordStart !== 1) {
        return false;
    }

    const nextAfterDot = nextNonSpaceIndex(chars, dotIndex + 1);
    if (
        nextAfterDot >= 0 &&
        isLower(chars[nextAfterDot]!) &&
        isUpper(chars[previous]!) &&
        isUpper(chars[previousLetter]!)
    ) {
        return false;
    }

    return true;
}

function previousNonSpaceIndex(chars: string[], start: number): number {
    for (let index = start; index >= 0; index -= 1) {
        if (!isSpace(chars[index]!)) {
            return index;
        }
    }

    return -1;
}

function nextNonSpaceIndex(chars: string[], start: number): number {
    for (let index = start; index < chars.length; index += 1) {
        if (!isSpace(chars[index]!)) {
            return index;
        }
    }

    return -1;
}

function isSentenceClosingChar(char: string): boolean {
    return ['"', "'", ")", "]", "}", "»", "“", "”"].includes(char);
}

function isEmptyLine(line: string): boolean {
    return line.trim() === "";
}

function trimRightCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isSpace(char: string): boolean {
    return /^\s$/u.test(char);
}

function isDigit(char: string): boolean {
    return /^\p{N}$/u.test(char);
}

function isLetter(char: string): boolean {
    return /^\p{L}$/u.test(char);
}

function isUpper(char: string): boolean {
    return isLetter(char) && char === char.toLocaleUpperCase() && char !== char.toLocaleLowerCase();
}

function isLower(char: string): boolean {
    return isLetter(char) && char === char.toLocaleLowerCase() && char !== char.toLocaleUpperCase();
}
