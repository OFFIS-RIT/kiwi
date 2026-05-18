import { Effect } from "effect";
import type {
    BoundingBox,
    Edge,
    ImageOccurrence,
    PageText,
    PDFParserOptions,
    RenderBlock,
    TableBlock,
    TextLine,
    Word,
} from "./types";
import { getTop, intersectsAny, median, squashWhitespace, unionBoxes } from "./geometry";
import { orderItemsByReadingLayout } from "./layout";
import { detectTablesEffect, extractWordsEffect, lineCenterInAnyBox, lineHasTableWords } from "./table";
import { getLineText, inferLineDirection } from "./text";

export function renderPageMarkdown(
    pageText: PageText,
    images: ImageOccurrence[],
    explicitEdges: Edge[],
    repeatedEdgePatterns: Set<string>,
    options: PDFParserOptions = {}
): string {
    return Effect.runSync(renderPageMarkdownEffect(pageText, images, explicitEdges, repeatedEdgePatterns, options));
}

export function renderPageMarkdownEffect(
    pageText: PageText,
    images: ImageOccurrence[],
    explicitEdges: Edge[],
    repeatedEdgePatterns: Set<string>,
    options: PDFParserOptions = {}
): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        const words = yield* extractWordsEffect(pageText);
        const tables = yield* detectTablesEffect(pageText, words, pageText.lines, explicitEdges, options.tableMode);
        return yield* Effect.try({
            try: () => renderPageMarkdownFromBlocks(pageText, images, repeatedEdgePatterns, words, tables),
            catch: (error) => error,
        });
    });
}

function renderPageMarkdownFromBlocks(
    pageText: PageText,
    images: ImageOccurrence[],
    repeatedEdgePatterns: Set<string>,
    words: Word[],
    tables: TableBlock[]
): string {
    const lineFontSizes = pageText.lines
        .map((line) => getLineFontSize(line))
        .filter((size) => Number.isFinite(size) && size > 0);
    const bodyFontSize = median(lineFontSizes) || 12;

    const tableRegions = tables.map((table) => table.bbox);
    const normalLines = pageText.lines.filter((line, lineIndex) => {
        if (lineCenterInAnyBox(line.bbox, tableRegions) || intersectsAny(line.bbox, tableRegions, 0.2)) {
            return false;
        }

        const lineWords = words.filter((word) => word.lineIndex === lineIndex);
        if (lineHasTableWords(lineWords, tableRegions)) {
            return false;
        }

        if (isRepeatedEdgeLine(line, pageText.height, repeatedEdgePatterns)) {
            return false;
        }

        return getLineText(line).length > 0;
    });

    const blocks: RenderBlock[] = [];
    const renderedTextBlocks = buildTextBlocks(normalLines, bodyFontSize);
    blocks.push(...renderedTextBlocks);

    for (const table of tables) {
        blocks.push({
            kind: "table",
            top: getTop(table.bbox),
            left: table.bbox.x,
            text: table.markdown,
            bbox: table.bbox,
        });
    }

    for (const image of images) {
        if (!intersectsAny(image.bbox, tableRegions, 0.35)) {
            blocks.push({
                kind: "image",
                top: getTop(image.bbox),
                left: image.bbox.x,
                text: `:::IMG-${image.id}:::`,
                bbox: image.bbox,
            });
        }
    }

    const orderedBlocks = orderItemsByReadingLayout(blocks, (block) => block.bbox, pageText.width);

    return orderedBlocks
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n\n");
}

export function findRepeatedEdgeLinePatterns(pageTexts: PageText[]): Set<string> {
    return Effect.runSync(findRepeatedEdgeLinePatternsEffect(pageTexts));
}

export function findRepeatedEdgeLinePatternsEffect(pageTexts: PageText[]): Effect.Effect<Set<string>, unknown> {
    return Effect.try({
        try: () => findRepeatedEdgeLinePatternsSync(pageTexts),
        catch: (error) => error,
    });
}

function findRepeatedEdgeLinePatternsSync(pageTexts: PageText[]): Set<string> {
    const counts = new Map<string, number>();

    for (const pageText of pageTexts) {
        const seen = new Set<string>();
        for (const line of pageText.lines) {
            const canonical = canonicalizeEdgeLine(line, pageText.height);
            if (!canonical || seen.has(canonical)) {
                continue;
            }

            seen.add(canonical);
            counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
        }
    }

    const minimumCount = Math.min(3, Math.max(2, Math.floor(pageTexts.length / 2)));
    return new Set([...counts.entries()].filter(([, count]) => count >= minimumCount).map(([canonical]) => canonical));
}

export function isRepeatedEdgeLine(line: TextLine, pageHeight: number, repeatedEdgePatterns: Set<string>): boolean {
    const canonical = canonicalizeEdgeLine(line, pageHeight);
    return canonical !== null && repeatedEdgePatterns.has(canonical);
}

export function canonicalizeEdgeLine(line: TextLine, pageHeight: number): string | null {
    const text = getLineText(line);
    if (!text || !isNearPageEdge(line.bbox, pageHeight)) {
        return null;
    }

    return text.replace(/\d+/g, "#");
}

export function isNearPageEdge(bbox: BoundingBox, pageHeight: number): boolean {
    return getTop(bbox) >= pageHeight * 0.92 || bbox.y <= pageHeight * 0.08;
}

export function buildTextBlocks(lines: TextLine[], bodyFontSize: number): RenderBlock[] {
    const blocks: RenderBlock[] = [];
    let paragraph: { top: number; left: number; lines: string[]; bbox: BoundingBox } | null = null;
    let previousLine: TextLine | null = null;

    for (const line of lines) {
        const normalized = getLineText(line);
        if (!normalized) {
            flushParagraph(blocks, paragraph);
            paragraph = null;
            previousLine = null;
            continue;
        }

        if (inferLineDirection(line) === "vertical") {
            flushParagraph(blocks, paragraph);
            paragraph = null;
            blocks.push({
                kind: "text",
                top: getTop(line.bbox),
                left: line.bbox.x,
                text: normalized,
                bbox: line.bbox,
            });
            previousLine = null;
            continue;
        }

        const headingLevel = getHeadingLevel(line, bodyFontSize);
        if (headingLevel > 0) {
            flushParagraph(blocks, paragraph);
            paragraph = null;
            blocks.push({
                kind: "text",
                top: getTop(line.bbox),
                left: line.bbox.x,
                text: `${"#".repeat(headingLevel)} ${normalized}`,
                bbox: line.bbox,
            });
            previousLine = null;
            continue;
        }

        if (!paragraph) {
            paragraph = {
                top: getTop(line.bbox),
                left: line.bbox.x,
                lines: [normalized],
                bbox: line.bbox,
            };
            previousLine = line;
            continue;
        }

        const verticalGap = previousLine ? previousLine.bbox.y - getTop(line.bbox) : 0;
        const sameParagraph =
            previousLine !== null &&
            verticalGap <= Math.max(previousLine.bbox.height, line.bbox.height) * 1.75 &&
            Math.abs(previousLine.bbox.x - line.bbox.x) <= 12;

        if (!sameParagraph) {
            flushParagraph(blocks, paragraph);
            paragraph = {
                top: getTop(line.bbox),
                left: line.bbox.x,
                lines: [normalized],
                bbox: line.bbox,
            };
            previousLine = line;
            continue;
        }

        paragraph.lines.push(normalized);
        paragraph.bbox = unionBoxes([paragraph.bbox, line.bbox]) ?? paragraph.bbox;
        previousLine = line;
    }

    flushParagraph(blocks, paragraph);

    return blocks;
}

export function flushParagraph(
    blocks: RenderBlock[],
    paragraph: { top: number; left: number; lines: string[]; bbox: BoundingBox } | null
): void {
    if (!paragraph || paragraph.lines.length === 0) {
        return;
    }

    blocks.push({
        kind: "text",
        top: paragraph.top,
        left: paragraph.left,
        text: paragraph.lines.join(" "),
        bbox: paragraph.bbox,
    });
}

export function getHeadingLevel(line: TextLine, bodyFontSize: number): number {
    if (inferLineDirection(line) === "vertical") {
        return 0;
    }

    const size = getLineFontSize(line);
    const normalized = getLineText(line);
    const length = normalized.length;
    if (length === 0 || length > 120) {
        return 0;
    }

    if (normalized.includes("....")) {
        return 0;
    }

    const numberedPrefix = normalized.match(/^(\d+(?:\.\d+)*)\s+/);
    if (numberedPrefix && length <= 80) {
        const prefix = numberedPrefix[1];
        if (prefix) {
            const firstNumber = Number(prefix.split(".")[0]);
            if (Number.isFinite(firstNumber) && firstNumber <= 20) {
                const depth = (prefix.match(/\./g) ?? []).length;
                return Math.min(3, depth + 1);
            }
        }
    }

    if (/^[A-ZÄÖÜ0-9\s-]+$/.test(normalized) && length <= 40 && size >= bodyFontSize * 1.05) {
        return 2;
    }

    if (/^\d{5}\s+/.test(normalized)) {
        return 0;
    }

    if (size >= bodyFontSize * 1.5) {
        return 1;
    }

    if (size >= bodyFontSize * 1.25) {
        return 2;
    }

    if (size >= bodyFontSize * 1.1 && length <= 90) {
        const depth = (normalized.match(/\./g) ?? []).length;
        return depth === 0 ? 3 : Math.min(3, depth + 1);
    }

    return 0;
}

export function getLineFontSize(line: TextLine): number {
    const samples: number[] = [];
    for (const span of line.spans) {
        const count = Math.max(span.text.trim().length, 1);
        for (let index = 0; index < count; index += 1) {
            samples.push(span.fontSize);
        }
    }

    return median(samples) || 0;
}
