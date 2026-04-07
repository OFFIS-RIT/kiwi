import { PDF } from "@libpdf/core";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { transcribePrompt } from "@kiwi/ai/prompts/transcribe.prompt";
import { generateText } from "ai";
import { pdf } from "pdf-to-img";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { processOCRImages } from "../lib/ocr-image";

type PDFOCRImage = {
    id: string;
    type: string;
    content: Uint8Array;
};

type PDFHybridResult = {
    text: string;
    images: PDFOCRImage[];
};

export type PDFMode = "plain" | "hybrid" | "ocr";

type PDFPageRasterizer = (content: Uint8Array) => Promise<Uint8Array[]>;
type PDFPageTranscriber = (image: Uint8Array, model: LanguageModelV3) => Promise<string>;

type FullOCRDeps = {
    rasterizePages?: PDFPageRasterizer;
    transcribePage?: PDFPageTranscriber;
};

type BoundingBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

type TextDirection = "horizontal" | "vertical";

type TextChar = {
    char: string;
    bbox: BoundingBox;
    fontSize: number;
    fontName: string;
    baseline: number;
    sequenceIndex?: number;
};

type TextSpan = {
    text: string;
    bbox: BoundingBox;
    chars: TextChar[];
    fontSize: number;
    fontName: string;
};

type TextLine = {
    text: string;
    bbox: BoundingBox;
    spans: TextSpan[];
    baseline: number;
    direction?: TextDirection;
};

type PageText = {
    pageIndex: number;
    width: number;
    height: number;
    lines: TextLine[];
    text: string;
};

type Matrix2D = {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
};

type PDFNameLike = {
    type: "name";
    value: string;
};

type PDFNumberLike = {
    type: "number";
    value: number;
};

type PDFRefLike = {
    type: "ref";
};

type PDFArrayLike = {
    type: "array";
    length: number;
    at: (index: number, resolver?: (ref: PDFRefLike) => unknown) => unknown;
    [Symbol.iterator](): Iterator<unknown>;
};

type PDFDictLike = {
    type: "dict" | "stream";
    get: (key: string | PDFNameLike, resolver?: (ref: PDFRefLike) => unknown) => unknown;
    getArray: (key: string, resolver?: (ref: PDFRefLike) => unknown) => PDFArrayLike | undefined;
    getDict: (key: string, resolver?: (ref: PDFRefLike) => unknown) => PDFDictLike | undefined;
    getName: (key: string, resolver?: (ref: PDFRefLike) => unknown) => PDFNameLike | undefined;
    getNumber: (key: string, resolver?: (ref: PDFRefLike) => unknown) => PDFNumberLike | undefined;
    [Symbol.iterator](): Iterator<[PDFNameLike, unknown]>;
};

type PDFStreamLike = PDFDictLike & {
    type: "stream";
    data: Uint8Array;
    getDecodedData: () => Uint8Array;
};

type PDFPageLike = {
    index: number;
    width: number;
    height: number;
    dict: PDFDictLike;
    getResources: () => PDFDictLike;
    extractText: () => PageText;
};

type PDFDocumentLike = {
    getPages: () => PDFPageLike[];
    getObject: (ref: PDFRefLike) => unknown;
};

type LineSegment = {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    width: number;
};

type Edge = {
    orientation: "vertical" | "horizontal";
    position: number;
    start: number;
    end: number;
    source: "explicit" | "text";
};

type Word = {
    text: string;
    bbox: BoundingBox;
    lineIndex: number;
};

type ImageOccurrence = {
    id: string;
    type: string;
    content: Uint8Array;
    bbox: BoundingBox;
    pageIndex: number;
};

type PageContentAnalysis = {
    images: ImageOccurrence[];
    explicitEdges: Edge[];
    actualTextSpans: ActualTextSpan[];
};

type PreparedPage = {
    pageText: PageText;
    content: PageContentAnalysis;
};

type PathState = {
    currentPoint: { x: number; y: number } | null;
    subpaths: LineSegment[];
    rectangles: BoundingBox[];
};

type GraphicsState = {
    ctm: Matrix2D;
    lineWidth: number;
    path: PathState;
};

type ActualTextSpan = {
    startSequenceIndex: number;
    endSequenceIndex: number;
    text: string;
    tag: string | null;
    mcid: number | null;
};

type MarkedContentEntry = {
    tag: string | null;
    mcid: number | null;
    actualText: string | null;
    startSequenceIndex: number | null;
    endSequenceIndex: number | null;
};

type MarkedContentState = {
    stack: MarkedContentEntry[];
    textSequenceIndex: number;
};

interface OperandDictionary {
    [key: string]: Operand;
}

type TableCell = {
    bbox: BoundingBox;
    row: number;
    col: number;
    text: string;
};

type TableBlock = {
    bbox: BoundingBox;
    markdown: string;
    cells: TableCell[];
    rowCount: number;
    colCount: number;
};

type TableSettings = {
    VerticalStrategy: "lines" | "lines_strict" | "text" | "explicit";
    HorizontalStrategy: "lines" | "lines_strict" | "text" | "explicit";
    ExplicitVerticalLines: number[];
    ExplicitHorizontalLines: number[];
    MinRows: number;
    MinCols: number;
    SnapTolerance: number;
    SnapXTolerance: number;
    SnapYTolerance: number;
    JoinTolerance: number;
    JoinXTolerance: number;
    JoinYTolerance: number;
    EdgeMinLength: number;
    EdgeMinLengthPrefilt: number;
    MinWordsVertical: number;
    MinWordsHorizontal: number;
    IntersectionTolerance: number;
    IntersectionXTol: number;
    IntersectionYTol: number;
    TextTolerance: number;
};

type TableBBox = {
    x0: number;
    top: number;
    x1: number;
    bottom: number;
};

type TablePoint = {
    x: number;
    y: number;
};

type TableIntersectionEdges = {
    v: TableEdge[];
    h: TableEdge[];
};

type TableEdge = {
    objectType: string;
    orientation: "v" | "h";
    x0: number;
    x1: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
};

type TableWord = {
    text: string;
    x0: number;
    x1: number;
    top: number;
    bottom: number;
    lineIndex: number;
};

type TableChar = {
    text: string;
    x0: number;
    x1: number;
    top: number;
    bottom: number;
    fontSize: number;
    fontName: string;
    baseline: number;
    sequenceIndex?: number;
};

type TablePage = {
    bbox: TableBBox;
    words: TableWord[];
    chars: TableChar[];
    edges: TableEdge[];
};

type TableModelData = {
    page: TablePage;
    cells: TableBBox[];
};

type TableCellGroup = {
    cells: Array<TableBBox | null>;
    bbox: TableBBox | null;
};

type RenderBlock = {
    kind: "text" | "table" | "image";
    top: number;
    left: number;
    text: string;
    bbox: BoundingBox;
};

type PositionedRegion<T> = {
    value: T;
    bbox: BoundingBox;
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
};

type LineSegmentBlock = {
    text: string;
    bbox: BoundingBox;
};

type SegmentedLine = {
    lineIndex: number;
    bbox: BoundingBox;
    segments: LineSegmentBlock[];
};

type Operand = number | string | Uint8Array | Operand[] | OperandDictionary | null;

const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const DEFAULT_LINE_WIDTH = 1;
const EDGE_SNAP_TOLERANCE = 3;
const EDGE_JOIN_TOLERANCE = 3;
const EDGE_MIN_LENGTH = 6;
const TABLE_MIN_CELLS = 4;
const TABLE_MIN_ROWS = 2;
const TABLE_MIN_COLS = 2;
const TABLE_MAX_COLS = 12;
const TABLE_MAX_ROWS = 40;
const TABLE_DEFAULT_SNAP_TOLERANCE = 3;
const TABLE_DEFAULT_JOIN_TOLERANCE = 3;
const TABLE_DEFAULT_MIN_WORDS_VERTICAL = 3;
const TABLE_DEFAULT_MIN_WORDS_HORIZONTAL = 1;
const TABLE_DEFAULT_EDGE_MIN_LENGTH = 3;
const TABLE_DEFAULT_EDGE_MIN_PREFILT = 1;
const TABLE_DEFAULT_INTERSECTION_TOLERANCE = 3;
const TABLE_DEFAULT_TEXT_TOLERANCE = 3;
const TABLE_POINT_EQUALITY_TOLERANCE = 0.001;
const TEXT_CHAR_DEDUPE_TOLERANCE = 1;
const TEXT_DEFAULT_X_TOLERANCE = 3;
const TEXT_DEFAULT_Y_TOLERANCE = 3;
const TEXT_DEFAULT_X_TOLERANCE_RATIO = 0.55;
const TEXT_DEFAULT_Y_TOLERANCE_RATIO = 0.35;
const TEXT_SEGMENT_MIN_GAP = 12;
const TEXT_SEGMENT_GAP_RATIO = 4;
const DEFAULT_RASTER_SCALE = 3;
const PNG_MIME_TYPE = "image/png";
const LIGATURE_EXPANSIONS: Record<string, string> = {
    ﬀ: "ff",
    ﬃ: "ffi",
    ﬄ: "ffl",
    ﬁ: "fi",
    ﬂ: "fl",
    ﬆ: "st",
    ﬅ: "st",
};
const WORD_BOUNDARY_PUNCTUATION = new Set([",", ";", "!", "?"]);
const INLINE_TOKEN_CONNECTORS = new Set([".", "_", "/", "\\", "-", "+", "=", "^", "~", "*", ":"]);

export class PDFLoader implements GraphLoader {
    readonly filetype = "pdf";
    private cachedModeText?: Promise<string>;

    constructor(
        private options: {
            loader: GraphBinaryLoader;
            mode?: PDFMode;
            model?: LanguageModelV3;
            storage?: { bucket: string; imagePrefix: string };
        }
    ) {}

    async getText(): Promise<string> {
        const mode = this.options.mode ?? "plain";

        if (mode !== "plain") {
            this.cachedModeText ??= this.getModeText(mode);
            return this.cachedModeText;
        }

        const content = await this.options.loader.getBinary();
        const pdf = await PDF.load(new Uint8Array(content));
        return extractPlainTextFromDocument(pdf as unknown as PDFDocumentLike);
    }

    private async getModeText(mode: Exclude<PDFMode, "plain">): Promise<string> {
        if (mode === "hybrid") {
            return this.getHybridText();
        }

        return this.getFullOCRText();
    }

    private async getHybridText(): Promise<string> {
        const model = this.options.model;
        const storage = this.options.storage;
        if (!model || !storage) {
            throw new Error("PDF hybrid mode requires an image model and storage configuration");
        }

        const content = await this.options.loader.getBinary();
        const pdf = await PDF.load(new Uint8Array(content));
        const result = extractPDFHybridFromDocument(pdf as unknown as PDFDocumentLike);
        return processOCRImages(result.text, result.images, model, storage);
    }

    private async getFullOCRText(): Promise<string> {
        const model = this.options.model;
        if (!model) {
            throw new Error("PDF full OCR requires an image-capable model");
        }

        const content = await this.options.loader.getBinary();
        return extractFullOCRTextFromPDF(content, model);
    }
}

function extractPDFHybridFromDocument(pdf: PDFDocumentLike): PDFHybridResult {
    const pages = pdf.getPages();
    const images: PDFOCRImage[] = [];
    const pageMarkdown: string[] = [];
    const preparedPages: PreparedPage[] = [];
    let imageCounter = 0;

    for (const page of pages) {
        const content = analyzePageContent(pdf, page, () => {
            imageCounter += 1;
            return `img-${imageCounter}`;
        });
        const pageText = normalizePageText(applyActualTextToPageText(page.extractText(), content.actualTextSpans));

        preparedPages.push({ pageText, content });
    }

    const repeatedEdgePatterns = findRepeatedEdgeLinePatterns(preparedPages.map((entry) => entry.pageText));

    for (const entry of preparedPages) {
        const { pageText, content } = entry;

        const markdown = renderPageMarkdown(pageText, content.images, content.explicitEdges, repeatedEdgePatterns);
        const referencedImageIds = extractReferencedImageIds(markdown);
        for (const image of content.images) {
            if (!referencedImageIds.has(image.id)) {
                continue;
            }

            images.push({ id: image.id, type: image.type, content: image.content });
        }

        if (markdown.trim().length > 0) {
            pageMarkdown.push(markdown.trim());
        }
    }

    return {
        text: pageMarkdown.join("\n\n"),
        images,
    };
}

function extractReferencedImageIds(markdown: string): Set<string> {
    const ids = new Set<string>();
    for (const match of markdown.matchAll(/:::IMG-([^:]+):::/g)) {
        const id = match[1];
        if (id) {
            ids.add(id);
        }
    }

    return ids;
}

function extractPlainTextFromDocument(pdf: PDFDocumentLike): string {
    return pdf
        .getPages()
        .map((page) => {
            const content = analyzePageContent(pdf, page, () => "ignored-image");
            return normalizePageText(
                applyActualTextToPageText(page.extractText(), content.actualTextSpans)
            ).text.trim();
        })
        .filter(Boolean)
        .join("\n\n");
}

export async function extractFullOCRTextFromPDF(
    content: ArrayBuffer,
    model: LanguageModelV3,
    deps: FullOCRDeps = {}
): Promise<string> {
    const rasterizePages = deps.rasterizePages ?? defaultRasterizePages;
    const transcribePage = deps.transcribePage ?? defaultTranscribePage;
    const pageImages = await rasterizePages(new Uint8Array(content));
    const pageTexts: string[] = [];

    for (const pageImage of pageImages) {
        const pageText = (await transcribePage(pageImage, model)).trim();
        if (pageText.length > 0) {
            pageTexts.push(pageText);
        }
    }

    return pageTexts.join("\n\n");
}

async function defaultRasterizePages(content: Uint8Array): Promise<Uint8Array[]> {
    const document = await pdf(Buffer.from(content), { scale: DEFAULT_RASTER_SCALE });
    const pageImages: Uint8Array[] = [];

    for await (const image of document) {
        pageImages.push(image);
    }

    return pageImages;
}

async function defaultTranscribePage(image: Uint8Array, model: LanguageModelV3): Promise<string> {
    const base64 = Buffer.from(image).toString("base64");
    const { text } = await generateText({
        model,
        system: transcribePrompt,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "image",
                        image: `data:${PNG_MIME_TYPE};base64,${base64}`,
                    },
                ],
            },
        ],
    });

    return text;
}

function normalizePageText(pageText: PageText): PageText {
    const horizontalLines: TextLine[] = [];
    const verticalChars: TextChar[] = [];

    for (const line of pageText.lines) {
        const chars = getPreparedLineChars(line);
        if (chars.length === 0) {
            horizontalLines.push({ ...line, direction: "horizontal" });
            continue;
        }

        const horizontalSubset = chars.filter((char) => inferTextCharDirection(char) === "horizontal");
        const visibleHorizontalChars = horizontalSubset.filter(
            (char) => getExpandedCharText(char.char).trim().length > 0
        );
        const verticalSubset = chars.filter((char) => inferTextCharDirection(char) === "vertical");
        const visibleVerticalChars = verticalSubset.filter((char) => getExpandedCharText(char.char).trim().length > 0);

        if (visibleHorizontalChars.length > 0) {
            for (const segment of splitHorizontalTextLine(horizontalSubset)) {
                const horizontalLine = createSyntheticTextLine(segment, "horizontal");
                if (horizontalLine) {
                    horizontalLines.push(horizontalLine);
                }
            }
            verticalChars.push(...visibleVerticalChars);
            continue;
        }

        if (
            visibleVerticalChars.length > 0 ||
            (verticalSubset.length > 0 && inferLineDirection(line, chars) === "vertical")
        ) {
            verticalChars.push(...verticalSubset);
            continue;
        }

        for (const segment of splitHorizontalTextLine(chars)) {
            const horizontalLine = createSyntheticTextLine(segment, "horizontal");
            if (horizontalLine) {
                horizontalLines.push(horizontalLine);
            }
        }
    }

    const lines = orderItemsByReadingLayout(
        [...horizontalLines, ...buildVerticalTextLines(verticalChars)],
        (line) => line.bbox,
        pageText.width
    );
    return {
        ...pageText,
        lines,
        text: lines
            .map((line) => getNormalizedLineText(line))
            .filter(Boolean)
            .join("\n"),
    };
}

function applyActualTextToPageText(pageText: PageText, spans: ActualTextSpan[]): PageText {
    if (spans.length === 0) {
        return pageText;
    }

    const flattened = pageText.lines.flatMap((line, lineIndex) =>
        line.spans.flatMap((span, spanIndex) =>
            span.chars.map((char, charIndex) => ({ char, lineIndex, spanIndex, charIndex }))
        )
    );
    const accepted = selectNonOverlappingActualTextSpans(spans)
        .map((span) => {
            const matched = flattened
                .filter((entry) => {
                    const sequenceIndex = entry.char.sequenceIndex;
                    return (
                        typeof sequenceIndex === "number" &&
                        sequenceIndex >= span.startSequenceIndex &&
                        sequenceIndex <= span.endSequenceIndex
                    );
                })
                .sort((left, right) => (left.char.sequenceIndex ?? 0) - (right.char.sequenceIndex ?? 0));
            if (matched.length === 0) {
                return null;
            }

            return {
                span,
                matched,
                replacement: createActualTextReplacementChar(
                    matched.map((entry) => entry.char),
                    span.text
                ),
            };
        })
        .filter(
            (entry): entry is { span: ActualTextSpan; matched: typeof flattened; replacement: TextChar } =>
                entry !== null
        );
    if (accepted.length === 0) {
        return pageText;
    }

    const replacementBySequence = new Map<number, TextChar>();
    const skippedSequences = new Set<number>();
    for (const entry of accepted) {
        const first = entry.matched[0]?.char.sequenceIndex;
        if (typeof first !== "number") {
            continue;
        }

        replacementBySequence.set(first, entry.replacement);
        for (const match of entry.matched.slice(1)) {
            if (typeof match.char.sequenceIndex === "number") {
                skippedSequences.add(match.char.sequenceIndex);
            }
        }
    }

    const lines = pageText.lines
        .map((line) => {
            const spans = line.spans
                .map((span) => {
                    const chars: TextChar[] = [];
                    for (const char of span.chars) {
                        const sequenceIndex = char.sequenceIndex;
                        if (typeof sequenceIndex === "number") {
                            const replacement = replacementBySequence.get(sequenceIndex);
                            if (replacement) {
                                chars.push(replacement);
                                continue;
                            }
                            if (skippedSequences.has(sequenceIndex)) {
                                continue;
                            }
                        }

                        chars.push(char);
                    }

                    const bbox = unionBoxes(chars.map((char) => char.bbox));
                    if (!bbox) {
                        return null;
                    }

                    return {
                        ...span,
                        text: chars.map((char) => char.char).join(""),
                        chars,
                        bbox,
                    };
                })
                .filter((span): span is TextSpan => span !== null && span.chars.length > 0);
            if (spans.length === 0) {
                return null;
            }

            const chars = spans.flatMap((span) => span.chars);
            const bbox = unionBoxes(chars.map((char) => char.bbox));
            if (!bbox) {
                return null;
            }

            return {
                ...line,
                text: spans.map((span) => span.text).join(""),
                spans,
                bbox,
                baseline: average(chars.map((char) => char.baseline)),
            };
        })
        .filter((line): line is TextLine => line !== null);

    return {
        ...pageText,
        lines,
        text: lines.map((line) => line.text).join("\n"),
    };
}

function selectNonOverlappingActualTextSpans(spans: ActualTextSpan[]): ActualTextSpan[] {
    const accepted: ActualTextSpan[] = [];
    const sorted = [...spans].sort((left, right) => {
        const leftLength = left.endSequenceIndex - left.startSequenceIndex;
        const rightLength = right.endSequenceIndex - right.startSequenceIndex;
        if (leftLength !== rightLength) {
            return leftLength - rightLength;
        }

        return left.startSequenceIndex - right.startSequenceIndex;
    });

    for (const span of sorted) {
        if (
            accepted.some(
                (existing) =>
                    span.startSequenceIndex <= existing.endSequenceIndex &&
                    span.endSequenceIndex >= existing.startSequenceIndex
            )
        ) {
            continue;
        }

        accepted.push(span);
    }

    return accepted.sort((left, right) => left.startSequenceIndex - right.startSequenceIndex);
}

function createActualTextReplacementChar(chars: TextChar[], text: string): TextChar {
    const bbox = unionBoxes(chars.map((char) => char.bbox)) ?? chars[0]!.bbox;
    return {
        char: text,
        bbox,
        fontSize: median(chars.map((char) => char.fontSize)) || chars[0]!.fontSize,
        fontName: chars[0]?.fontName ?? "",
        baseline: average(chars.map((char) => char.baseline)),
        sequenceIndex: chars[0]?.sequenceIndex,
    };
}

function inferLineDirection(line: TextLine, chars = getPreparedLineChars(line)): TextDirection {
    const visibleChars = chars.filter((char) => getExpandedCharText(char.char).trim().length > 0);
    const samples = visibleChars.length > 0 ? visibleChars : chars;
    if (samples.length === 0) {
        return line.direction ?? "horizontal";
    }

    const verticalCount = samples.filter((char) => inferTextCharDirection(char) === "vertical").length;
    if (verticalCount >= Math.ceil(samples.length * 0.6)) {
        return "vertical";
    }

    return line.direction ?? "horizontal";
}

function splitHorizontalTextLine(chars: TextChar[]): TextChar[][] {
    const ordered = dedupeTextChars(sortTextChars(chars));
    if (ordered.length === 0) {
        return [];
    }

    const visibleChars = ordered.filter((char) => getExpandedCharText(char.char).trim().length > 0);
    const averageWidth = average(visibleChars.map((char) => char.bbox.width)) || 4;
    const medianFontSize = median(visibleChars.map((char) => char.fontSize)) || 12;
    const breakThreshold = Math.max(24, averageWidth * 4.5, medianFontSize * 2.4);
    const groups: TextChar[][] = [[]];

    for (let index = 0; index < ordered.length; index += 1) {
        const char = ordered[index]!;
        const current = groups[groups.length - 1]!;
        const previousVisible = [...current]
            .reverse()
            .find((entry) => getExpandedCharText(entry.char).trim().length > 0);
        const nextVisible = ordered.slice(index + 1).find((entry) => getExpandedCharText(entry.char).trim().length > 0);
        const text = getExpandedCharText(char.char);

        if (text.trim().length === 0) {
            const wideWhitespace = char.bbox.width >= breakThreshold;
            const gapToNext = nextVisible ? nextVisible.bbox.x - (char.bbox.x + char.bbox.width) : 0;
            if (wideWhitespace || gapToNext >= breakThreshold * 0.5) {
                if (current.length > 0) {
                    groups.push([]);
                }
                continue;
            }
        }

        if (previousVisible) {
            const gap = char.bbox.x - (previousVisible.bbox.x + previousVisible.bbox.width);
            if (gap >= breakThreshold) {
                groups.push([]);
            }
        }

        groups[groups.length - 1]!.push(char);
    }

    const visibleGroups = groups.filter((group) =>
        group.some((char) => getExpandedCharText(char.char).trim().length > 0)
    );
    if (visibleGroups.length !== 2) {
        return [ordered];
    }

    const proseLikeGroups = visibleGroups.filter((group) => {
        const text = normalizeWhitespace(reconstructTextFromChars(group));
        return text.length >= 20 && /\s/.test(text);
    });
    return proseLikeGroups.length === 2 ? visibleGroups : [ordered];
}

function inferTextCharDirection(char: TextChar): TextDirection {
    return char.bbox.width >= Math.max(char.bbox.height * 1.05, char.fontSize * 0.75) ? "vertical" : "horizontal";
}

function buildVerticalTextLines(chars: TextChar[]): TextLine[] {
    if (chars.length === 0) {
        return [];
    }

    return clusterVerticalTextChars(chars)
        .flatMap(splitVerticalTextCluster)
        .map((group) => createSyntheticTextLine(group, "vertical"))
        .filter((line): line is TextLine => line !== null);
}

function clusterVerticalTextChars(chars: TextChar[]): TextChar[][] {
    const ordered = dedupeTextChars([...chars]).sort(
        (left, right) => getTextCharCenterX(left) - getTextCharCenterX(right)
    );
    const clusters: TextChar[][] = [];

    for (const char of ordered) {
        const current = clusters[clusters.length - 1];
        if (!current) {
            clusters.push([char]);
            continue;
        }

        const fontSize = median(current.map((entry) => entry.fontSize)) || char.fontSize;
        if (
            Math.abs(getTextCharCenterX(char) - average(current.map(getTextCharCenterX))) <= Math.max(4, fontSize * 0.9)
        ) {
            current.push(char);
            continue;
        }

        clusters.push([char]);
    }

    return clusters;
}

function splitVerticalTextCluster(cluster: TextChar[]): TextChar[][] {
    const ordered = sortVerticalTextChars(cluster);
    if (ordered.length === 0) {
        return [];
    }

    const groups: TextChar[][] = [[ordered[0]!]];
    for (const char of ordered.slice(1)) {
        const current = groups[groups.length - 1]!;
        const previous = current[current.length - 1]!;
        const fontSize = median(current.map((entry) => entry.fontSize)) || char.fontSize;
        const verticalGap = Math.abs(getTextCharCenterY(char) - getTextCharCenterY(previous));
        const sequenceGap =
            typeof previous.sequenceIndex === "number" && typeof char.sequenceIndex === "number"
                ? Math.abs(char.sequenceIndex - previous.sequenceIndex)
                : 1;

        if (
            verticalGap > Math.max(fontSize * 3, 18) ||
            (sequenceGap > 2 && verticalGap > Math.max(fontSize * 1.5, 10))
        ) {
            groups.push([char]);
            continue;
        }

        current.push(char);
    }

    return groups.filter((group) => group.some((char) => getExpandedCharText(char.char).trim().length > 0));
}

function createSyntheticTextLine(chars: TextChar[], direction: TextDirection): TextLine | null {
    const orderedChars = direction === "vertical" ? sortVerticalTextChars(chars) : sortTextChars(chars);
    const bbox = unionBoxes(orderedChars.map((char) => char.bbox));
    if (!bbox) {
        return null;
    }

    const text =
        direction === "vertical"
            ? reconstructVerticalTextFromChars(orderedChars)
            : cleanupExtractedTextSpacing(reconstructTextFromChars(orderedChars));
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
        return null;
    }

    const fontSize = median(orderedChars.map((char) => char.fontSize)) || 0;
    const fontName = orderedChars[0]?.fontName ?? "";
    const baseline =
        direction === "vertical"
            ? average(orderedChars.map(getTextCharCenterY))
            : (orderedChars[0]?.baseline ?? bbox.y);

    return {
        text: normalized,
        bbox,
        baseline,
        direction,
        spans: [
            {
                text: normalized,
                bbox,
                chars: orderedChars,
                fontSize,
                fontName,
            },
        ],
    };
}

function sortVerticalTextChars(chars: TextChar[]): TextChar[] {
    return [...chars].sort((left, right) => {
        if (typeof left.sequenceIndex === "number" && typeof right.sequenceIndex === "number") {
            if (left.sequenceIndex !== right.sequenceIndex) {
                return left.sequenceIndex - right.sequenceIndex;
            }
        }

        return getTextCharCenterY(right) - getTextCharCenterY(left);
    });
}

function reconstructVerticalTextFromChars(chars: TextChar[]): string {
    const parts: string[] = [];

    for (const char of sortVerticalTextChars(dedupeTextChars(chars))) {
        const text = getExpandedCharText(char.char);
        if (text.trim().length === 0) {
            if (parts.length > 0 && parts[parts.length - 1] !== " ") {
                parts.push(" ");
            }
            continue;
        }

        parts.push(text);
    }

    return parts.join("").replace(/\s+/g, " ").trim();
}

function orderItemsByReadingLayout<T>(items: T[], getBBox: (item: T) => BoundingBox, pageWidth: number): T[] {
    return orderPositionedRegions(
        items.map((item) => createPositionedRegion(item, getBBox(item))),
        pageWidth,
        0
    ).map((region) => region.value);
}

function createPositionedRegion<T>(value: T, bbox: BoundingBox): PositionedRegion<T> {
    const left = bbox.x;
    const right = bbox.x + bbox.width;
    const top = getTop(bbox);
    const bottom = bbox.y;
    return {
        value,
        bbox,
        left,
        right,
        top,
        bottom,
        width: bbox.width,
        height: bbox.height,
        centerX: left + bbox.width / 2,
        centerY: bottom + bbox.height / 2,
    };
}

function orderPositionedRegions<T>(
    regions: PositionedRegion<T>[],
    pageWidth: number,
    depth: number
): PositionedRegion<T>[] {
    if (regions.length <= 1 || depth >= 8) {
        return sortRegionsTopLeft(regions);
    }

    const verticalSplit = findVerticalReadingSplit(regions, pageWidth);
    if (verticalSplit) {
        return orderRegionsWithVerticalSplit(verticalSplit, pageWidth, depth + 1);
    }

    const horizontalSplit = findHorizontalReadingSplit(regions);
    if (horizontalSplit) {
        return [
            ...orderPositionedRegions(horizontalSplit.top, pageWidth, depth + 1),
            ...orderPositionedRegions(horizontalSplit.bottom, pageWidth, depth + 1),
        ];
    }

    return sortRegionsTopLeft(regions);
}

function sortRegionsTopLeft<T>(regions: PositionedRegion<T>[]): PositionedRegion<T>[] {
    return [...regions].sort((left, right) => {
        const topDelta = right.top - left.top;
        if (Math.abs(topDelta) > 1) {
            return topDelta;
        }

        return left.left - right.left;
    });
}

function findHorizontalReadingSplit<T>(
    regions: PositionedRegion<T>[]
): { top: PositionedRegion<T>[]; bottom: PositionedRegion<T>[] } | null {
    if (regions.length < 3) {
        return null;
    }

    const sorted = sortRegionsTopLeft(regions);
    const heights = sorted.map((region) => region.height).filter((height) => height > 0);
    const baselineGap = Math.max(18, (median(heights) || 12) * 2.5);
    let runningBottom = sorted[0]?.bottom ?? 0;
    let bestIndex = -1;
    let bestGap = 0;

    for (let index = 1; index < sorted.length; index += 1) {
        const region = sorted[index];
        if (!region) {
            continue;
        }

        const gap = runningBottom - region.top;
        if (gap > baselineGap && gap > bestGap) {
            bestGap = gap;
            bestIndex = index;
        }

        runningBottom = Math.min(runningBottom, region.bottom);
    }

    if (bestIndex <= 0 || bestIndex >= sorted.length) {
        return null;
    }

    return {
        top: sorted.slice(0, bestIndex),
        bottom: sorted.slice(bestIndex),
    };
}

function findVerticalReadingSplit<T>(
    regions: PositionedRegion<T>[],
    pageWidth: number
): {
    left: PositionedRegion<T>[];
    right: PositionedRegion<T>[];
    spanning: PositionedRegion<T>[];
} | null {
    if (regions.length < 2) {
        return null;
    }

    const centerLeft = pageWidth * 0.45;
    const centerRight = pageWidth * 0.55;
    const narrowRegions = regions.filter(
        (region) => region.width <= pageWidth * 0.55 && (region.right <= centerLeft || region.left >= centerRight)
    );
    if (narrowRegions.length < 2) {
        return null;
    }

    const merged = mergeHorizontalIntervals(narrowRegions.map((region) => ({ start: region.left, end: region.right })));
    if (merged.length < 2) {
        return null;
    }

    const minimumGap = Math.max(24, pageWidth * 0.04);
    let bestGap: { start: number; end: number } | null = null;
    for (let index = 0; index < merged.length - 1; index += 1) {
        const current = merged[index];
        const next = merged[index + 1];
        if (!current || !next) {
            continue;
        }

        const gapWidth = next.start - current.end;
        if (gapWidth < minimumGap) {
            continue;
        }

        if (!bestGap || gapWidth > bestGap.end - bestGap.start) {
            bestGap = { start: current.end, end: next.start };
        }
    }

    if (!bestGap) {
        return null;
    }

    const center = (bestGap.start + bestGap.end) / 2;
    const tolerance = Math.max(6, (bestGap.end - bestGap.start) * 0.15);
    const left = regions.filter((region) => region.right <= center + tolerance);
    const right = regions.filter((region) => region.left >= center - tolerance);
    const spanning = regions.filter((region) => !left.includes(region) && !right.includes(region));
    if (left.length === 0 || right.length === 0) {
        return null;
    }

    const hasParallelContent = left.some((leftRegion) =>
        right.some((rightRegion) =>
            verticalRegionsOverlap(
                leftRegion,
                rightRegion,
                Math.max(8, Math.min(leftRegion.height, rightRegion.height))
            )
        )
    );
    if (!hasParallelContent) {
        return null;
    }

    return { left, right, spanning };
}

function mergeHorizontalIntervals(
    intervals: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
    const sorted = [...intervals].sort((left, right) => left.start - right.start);
    const merged: Array<{ start: number; end: number }> = [];
    const tolerance = 12;

    for (const interval of sorted) {
        const current = merged[merged.length - 1];
        if (!current || interval.start > current.end + tolerance) {
            merged.push({ ...interval });
            continue;
        }

        current.end = Math.max(current.end, interval.end);
    }

    return merged;
}

function verticalRegionsOverlap<T>(left: PositionedRegion<T>, right: PositionedRegion<T>, tolerance: number): boolean {
    return overlapLength(left.bottom, left.top, right.bottom, right.top) > -tolerance;
}

function orderRegionsWithVerticalSplit<T>(
    split: { left: PositionedRegion<T>[]; right: PositionedRegion<T>[]; spanning: PositionedRegion<T>[] },
    pageWidth: number,
    depth: number
): PositionedRegion<T>[] {
    if (split.spanning.length === 0) {
        return [
            ...orderPositionedRegions(split.left, pageWidth, depth),
            ...orderPositionedRegions(split.right, pageWidth, depth),
        ];
    }

    const spanning = sortRegionsTopLeft(split.spanning);
    const nonSpanning = [...split.left, ...split.right];
    const ordered: PositionedRegion<T>[] = [];
    let currentTop = Number.POSITIVE_INFINITY;

    for (const span of spanning) {
        const above = nonSpanning.filter((region) => region.centerY < currentTop && region.centerY > span.top);
        if (above.length > 0) {
            ordered.push(...orderPositionedRegions(above, pageWidth, depth));
        }

        ordered.push(span);
        currentTop = span.bottom;
    }

    const below = nonSpanning.filter((region) => region.centerY < currentTop);
    if (below.length > 0) {
        ordered.push(...orderPositionedRegions(below, pageWidth, depth));
    }

    return dedupeOrderedRegions(ordered);
}

function dedupeOrderedRegions<T>(regions: PositionedRegion<T>[]): PositionedRegion<T>[] {
    const seen = new Set<PositionedRegion<T>>();
    const unique: PositionedRegion<T>[] = [];
    for (const region of regions) {
        if (seen.has(region)) {
            continue;
        }
        seen.add(region);
        unique.push(region);
    }
    return unique;
}

function getTextCharCenterX(char: TextChar): number {
    return char.bbox.x + char.bbox.width / 2;
}

function getTextCharCenterY(char: TextChar): number {
    return char.bbox.y + char.bbox.height / 2;
}

function renderPageMarkdown(
    pageText: PageText,
    images: ImageOccurrence[],
    explicitEdges: Edge[],
    repeatedEdgePatterns: Set<string>
): string {
    const words = extractWords(pageText);
    const tables = detectTables(pageText, words, pageText.lines, explicitEdges);
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

        return getNormalizedLineText(line).length > 0;
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

function findRepeatedEdgeLinePatterns(pageTexts: PageText[]): Set<string> {
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

function isRepeatedEdgeLine(line: TextLine, pageHeight: number, repeatedEdgePatterns: Set<string>): boolean {
    const canonical = canonicalizeEdgeLine(line, pageHeight);
    return canonical !== null && repeatedEdgePatterns.has(canonical);
}

function canonicalizeEdgeLine(line: TextLine, pageHeight: number): string | null {
    const text = getNormalizedLineText(line);
    if (!text || !isNearPageEdge(line.bbox, pageHeight)) {
        return null;
    }

    return text.replace(/\d+/g, "#");
}

function isNearPageEdge(bbox: BoundingBox, pageHeight: number): boolean {
    return getTop(bbox) >= pageHeight * 0.92 || bbox.y <= pageHeight * 0.08;
}

function buildTextBlocks(lines: TextLine[], bodyFontSize: number): RenderBlock[] {
    const blocks: RenderBlock[] = [];
    let paragraph: { top: number; left: number; lines: string[]; bbox: BoundingBox } | null = null;
    let previousLine: TextLine | null = null;

    for (const line of lines) {
        const normalized = getNormalizedLineText(line);
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

function flushParagraph(
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

function getHeadingLevel(line: TextLine, bodyFontSize: number): number {
    if (inferLineDirection(line) === "vertical") {
        return 0;
    }

    const size = getLineFontSize(line);
    const normalized = getNormalizedLineText(line);
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

function getLineFontSize(line: TextLine): number {
    const samples: number[] = [];
    for (const span of line.spans) {
        const count = Math.max(span.text.trim().length, 1);
        for (let index = 0; index < count; index += 1) {
            samples.push(span.fontSize);
        }
    }

    return median(samples) || 0;
}

function detectTables(pageText: PageText, words: Word[], lines: TextLine[], explicitEdges: Edge[]): TableBlock[] {
    const tablePage = buildTablePage(pageText, words, explicitEdges);
    const tables: TableBlock[] = [];
    const proseLikeMultiColumn = explicitEdges.length === 0 && looksLikeMultiColumnProseLayout(lines, pageText.width);

    appendUniqueTables(
        tables,
        buildTableBlocksFromModels(tablePage, tableFindTables(tablePage, tableDefaultSettings()), "lines")
    );
    if (!proseLikeMultiColumn) {
        appendUniqueTables(
            tables,
            buildTableBlocksFromModels(
                tablePage,
                tableFindTables(tablePage, tableSettingsForStrategy("text", "text")),
                "text"
            )
        );
        appendUniqueTables(
            tables,
            detectWhitespaceSeparatedTables(
                lines,
                tables.map((table) => table.bbox)
            )
        );
    }

    if (tables.length === 0 && explicitEdges.length > 0) {
        return detectTablesLegacy(pageText, explicitEdges);
    }

    tables.sort((a, b) => getTop(b.bbox) - getTop(a.bbox));

    return tables;
}

function looksLikeMultiColumnProseLayout(lines: TextLine[], pageWidth: number): boolean {
    const candidates = lines
        .filter((line) => inferLineDirection(line) === "horizontal")
        .map((line) => ({
            line,
            text: getNormalizedLineText(line),
        }))
        .filter(({ text }) => text.length > 0);
    if (candidates.length < 4) {
        return false;
    }

    const proseLines = candidates.filter(({ text }) => text.length >= 24 && /\s/.test(text));
    const numericLines = candidates.filter(({ text }) => /\d/.test(text)).length;
    if (proseLines.length < Math.ceil(candidates.length * 0.5) || numericLines > Math.floor(candidates.length / 3)) {
        return false;
    }

    const centerLeft = pageWidth * 0.45;
    const centerRight = pageWidth * 0.55;
    const sideProseLines = proseLines.filter(
        ({ line }) => line.bbox.x + line.bbox.width <= centerLeft || line.bbox.x >= centerRight
    );
    if (sideProseLines.length < 4) {
        return false;
    }

    const anchors = clusterNumericPositions(
        sideProseLines.map(({ line }) => Math.round(line.bbox.x / 6) * 6),
        Math.max(18, pageWidth * 0.04)
    );
    if (anchors.length < 2) {
        return false;
    }

    const left = sideProseLines.filter(({ line }) => Math.abs(line.bbox.x - anchors[0]!) <= 24).length;
    const right = sideProseLines.filter(({ line }) => Math.abs(line.bbox.x - anchors[1]!) <= 24).length;
    return left >= 2 && right >= 2 && Math.abs((anchors[1] ?? 0) - (anchors[0] ?? 0)) >= pageWidth * 0.18;
}

function appendUniqueTables(tables: TableBlock[], candidates: TableBlock[]): void {
    for (const table of candidates) {
        if (!tables.some((existing) => intersects(existing.bbox, table.bbox, 0.5))) {
            tables.push(table);
        }
    }
}

function buildTableBlocksFromModels(
    page: TablePage,
    models: TableModelData[],
    strategy: "lines" | "text"
): TableBlock[] {
    const tables: TableBlock[] = [];

    for (const model of models) {
        const rows = normalizeExtractedTableRows(tableExtractRows(model, TABLE_DEFAULT_TEXT_TOLERANCE));
        if (!tableIsLikelyTabular(rows)) {
            continue;
        }

        if (strategy === "text" && !tablePassesTextOnlyHeuristics(rows)) {
            continue;
        }

        const markdown = tableRowsToMarkdown(rows);
        if (!markdown) {
            continue;
        }

        const bbox = tableBBoxToBoundingBox(tableModelBBox(model), page.bbox.bottom);
        const normalized = normalizeTableCells(tableModelToCells(model, page.bbox.bottom));
        if (!normalized) {
            continue;
        }

        if (
            normalized.rowCount < TABLE_MIN_ROWS ||
            normalized.colCount < TABLE_MIN_COLS ||
            normalized.rowCount > TABLE_MAX_ROWS ||
            normalized.colCount > TABLE_MAX_COLS
        ) {
            continue;
        }

        tables.push({
            bbox,
            markdown,
            cells: normalized.cells,
            rowCount: normalized.rowCount,
            colCount: normalized.colCount,
        });
    }

    return tables;
}

function detectTablesLegacy(pageText: PageText, explicitEdges: Edge[]): TableBlock[] {
    const allEdges = mergeEdges([...explicitEdges]);
    const verticalEdges = allEdges.filter((edge) => edge.orientation === "vertical");
    const horizontalEdges = allEdges.filter((edge) => edge.orientation === "horizontal");
    if (verticalEdges.length < 2 || horizontalEdges.length < 2) {
        return [];
    }

    const cells = buildCells(verticalEdges, horizontalEdges, pageText);
    if (cells.length < TABLE_MIN_CELLS) {
        return [];
    }

    const grouped = groupCellsIntoTables(cells);
    const tables: TableBlock[] = [];
    for (const tableCells of grouped) {
        const markdown = buildMarkdownTable(tableCells);
        const bbox = unionBoxes(tableCells.map((cell) => cell.bbox));
        const normalized = normalizeTableCells(tableCells);
        if (!markdown || !bbox || !normalized) {
            continue;
        }

        tables.push({
            bbox,
            markdown,
            cells: normalized.cells,
            rowCount: normalized.rowCount,
            colCount: normalized.colCount,
        });
    }

    return tables;
}

function mergeEdges(edges: Edge[]): Edge[] {
    const snapped = edges.filter((edge) => edge.end - edge.start >= EDGE_MIN_LENGTH).map((edge) => ({ ...edge }));

    for (let index = 0; index < snapped.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < snapped.length; otherIndex += 1) {
            const current = snapped[index];
            const other = snapped[otherIndex];
            if (!current || !other) {
                continue;
            }

            if (current.orientation !== other.orientation) {
                continue;
            }

            if (Math.abs(current.position - other.position) <= EDGE_SNAP_TOLERANCE) {
                const position = average([current.position, other.position]);
                current.position = position;
                other.position = position;
            }
        }
    }

    const merged: Edge[] = [];
    const sorted = snapped.sort((a, b) => {
        if (a.orientation !== b.orientation) {
            return a.orientation.localeCompare(b.orientation);
        }

        if (Math.abs(a.position - b.position) > 0.001) {
            return a.position - b.position;
        }

        return a.start - b.start;
    });

    for (const edge of sorted) {
        const last = merged.at(-1);
        if (
            last &&
            last.orientation === edge.orientation &&
            Math.abs(last.position - edge.position) <= EDGE_SNAP_TOLERANCE &&
            edge.start <= last.end + EDGE_JOIN_TOLERANCE
        ) {
            last.start = Math.min(last.start, edge.start);
            last.end = Math.max(last.end, edge.end);
            continue;
        }

        merged.push({ ...edge });
    }

    return merged.filter((edge) => edge.end - edge.start >= EDGE_MIN_LENGTH);
}

function buildCells(verticalEdges: Edge[], horizontalEdges: Edge[], pageText: PageText): TableCell[] {
    const xs = uniqueSorted(verticalEdges.map((edge) => edge.position));
    const ys = uniqueSorted(horizontalEdges.map((edge) => edge.position));
    const cells: TableCell[] = [];

    for (let row = ys.length - 2; row >= 0; row -= 1) {
        for (let col = 0; col < xs.length - 1; col += 1) {
            const left = xs[col];
            const right = xs[col + 1];
            const bottom = ys[row];
            const top = ys[row + 1];
            if (left === undefined || right === undefined || bottom === undefined || top === undefined) {
                continue;
            }

            if (right - left < 4 || top - bottom < 4) {
                continue;
            }

            if (!hasCoveringVerticalEdge(verticalEdges, left, bottom, top)) {
                continue;
            }

            if (!hasCoveringVerticalEdge(verticalEdges, right, bottom, top)) {
                continue;
            }

            if (!hasCoveringHorizontalEdge(horizontalEdges, bottom, left, right)) {
                continue;
            }

            if (!hasCoveringHorizontalEdge(horizontalEdges, top, left, right)) {
                continue;
            }

            const bbox = { x: left, y: bottom, width: right - left, height: top - bottom };
            const text = reconstructTableCellTextFromPage(pageText, bbox);
            cells.push({
                bbox,
                row: ys.length - 2 - row,
                col,
                text,
            });
        }
    }

    return cells;
}

function reconstructTableCellTextFromPage(pageText: PageText, bbox: BoundingBox): string {
    const chars = pageText.lines.flatMap((line) =>
        getPreparedLineChars(line).filter(
            (char) => wordCenterInBox(char.bbox, bbox) || intersects(char.bbox, bbox, 0.05)
        )
    );

    return reconstructTableCellText(chars);
}

function reconstructTableCellText(chars: TextChar[]): string {
    if (chars.length === 0) {
        return "";
    }

    return reconstructTextLinesFromChars(chars, TABLE_DEFAULT_TEXT_TOLERANCE)
        .map((line) => normalizeTableCellText(reconstructLogicalLineText(line)))
        .filter(Boolean)
        .join("\n")
        .trim();
}

function wordCenterInBox(wordBox: BoundingBox, cellBox: BoundingBox): boolean {
    const centerX = wordBox.x + wordBox.width / 2;
    const centerY = wordBox.y + wordBox.height / 2;
    return (
        centerX >= cellBox.x - EDGE_SNAP_TOLERANCE &&
        centerX <= cellBox.x + cellBox.width + EDGE_SNAP_TOLERANCE &&
        centerY >= cellBox.y - EDGE_SNAP_TOLERANCE &&
        centerY <= cellBox.y + cellBox.height + EDGE_SNAP_TOLERANCE
    );
}

function lineCenterInAnyBox(lineBox: BoundingBox, boxes: BoundingBox[]): boolean {
    const centerX = lineBox.x + lineBox.width / 2;
    const centerY = lineBox.y + lineBox.height / 2;
    return boxes.some((box) => {
        return (
            centerX >= box.x - EDGE_SNAP_TOLERANCE &&
            centerX <= box.x + box.width + EDGE_SNAP_TOLERANCE &&
            centerY >= box.y - EDGE_SNAP_TOLERANCE &&
            centerY <= box.y + box.height + EDGE_SNAP_TOLERANCE
        );
    });
}

function lineHasTableWords(lineWords: Word[], tableRegions: BoundingBox[]): boolean {
    if (lineWords.length === 0 || tableRegions.length === 0) {
        return false;
    }

    const tableWordCount = lineWords.filter((word) =>
        tableRegions.some((region) => wordCenterInBox(word.bbox, region))
    ).length;
    return tableWordCount / lineWords.length >= 0.5;
}

function hasCoveringVerticalEdge(edges: Edge[], x: number, y0: number, y1: number): boolean {
    return edges.some((edge) => {
        if (edge.orientation !== "vertical") {
            return false;
        }

        if (Math.abs(edge.position - x) > EDGE_SNAP_TOLERANCE) {
            return false;
        }

        return edge.start <= y0 + EDGE_JOIN_TOLERANCE && edge.end >= y1 - EDGE_JOIN_TOLERANCE;
    });
}

function hasCoveringHorizontalEdge(edges: Edge[], y: number, x0: number, x1: number): boolean {
    return edges.some((edge) => {
        if (edge.orientation !== "horizontal") {
            return false;
        }

        if (Math.abs(edge.position - y) > EDGE_SNAP_TOLERANCE) {
            return false;
        }

        return edge.start <= x0 + EDGE_JOIN_TOLERANCE && edge.end >= x1 - EDGE_JOIN_TOLERANCE;
    });
}

function groupCellsIntoTables(cells: TableCell[]): TableCell[][] {
    const groups: TableCell[][] = [];
    const remaining = new Set(cells.map((_, index) => index));

    while (remaining.size > 0) {
        const [firstIndex] = remaining;
        if (firstIndex === undefined) {
            break;
        }

        const queue = [firstIndex];
        const group: TableCell[] = [];
        remaining.delete(firstIndex);

        while (queue.length > 0) {
            const index = queue.shift();
            if (index === undefined) {
                continue;
            }

            const cell = cells[index];
            if (!cell) {
                continue;
            }

            group.push(cell);

            for (const otherIndex of [...remaining]) {
                const other = cells[otherIndex];
                if (!other) {
                    continue;
                }

                if (!cellsTouch(cell, other)) {
                    continue;
                }

                remaining.delete(otherIndex);
                queue.push(otherIndex);
            }
        }

        groups.push(group);
    }

    return groups;
}

function cellsTouch(a: TableCell, b: TableCell): boolean {
    const horizontalTouch =
        Math.abs(a.bbox.x + a.bbox.width - b.bbox.x) <= EDGE_SNAP_TOLERANCE ||
        Math.abs(b.bbox.x + b.bbox.width - a.bbox.x) <= EDGE_SNAP_TOLERANCE;
    const verticalOverlap = overlapLength(a.bbox.y, getTop(a.bbox), b.bbox.y, getTop(b.bbox)) > 0;

    const verticalTouch =
        Math.abs(getTop(a.bbox) - b.bbox.y) <= EDGE_SNAP_TOLERANCE ||
        Math.abs(getTop(b.bbox) - a.bbox.y) <= EDGE_SNAP_TOLERANCE;
    const horizontalOverlap = overlapLength(a.bbox.x, a.bbox.x + a.bbox.width, b.bbox.x, b.bbox.x + b.bbox.width) > 0;

    return (horizontalTouch && verticalOverlap) || (verticalTouch && horizontalOverlap);
}

function buildMarkdownTable(cells: TableCell[]): string | null {
    if (cells.length === 0) {
        return null;
    }

    const rowCount = Math.max(...cells.map((cell) => cell.row)) + 1;
    const colCount = Math.max(...cells.map((cell) => cell.col)) + 1;
    if (
        rowCount < TABLE_MIN_ROWS ||
        colCount < TABLE_MIN_COLS ||
        rowCount > TABLE_MAX_ROWS ||
        colCount > TABLE_MAX_COLS
    ) {
        return null;
    }

    const grid = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => ""));
    for (const cell of cells) {
        const row = grid[cell.row];
        if (!row) {
            continue;
        }

        row[cell.col] = escapeMarkdownTableCell(cell.text);
    }

    while (grid.length > 0 && grid[0]?.every((value) => value.length === 0)) {
        grid.shift();
    }

    while (grid.length > 0 && grid[grid.length - 1]?.every((value) => value.length === 0)) {
        grid.pop();
    }

    if (grid.length < TABLE_MIN_ROWS) {
        return null;
    }

    const nonEmptyCells = grid.flat().filter(Boolean).length;
    if (nonEmptyCells < TABLE_MIN_CELLS - 1) {
        return null;
    }

    const effectiveRowCount = grid.length;
    if (nonEmptyCells / (effectiveRowCount * colCount) < 0.35) {
        return null;
    }

    const header = grid[0];
    if (!header) {
        return null;
    }
    if (header.filter(Boolean).length < Math.min(2, colCount)) {
        return null;
    }
    const separator = Array.from({ length: colCount }, () => "---");
    const body = grid.slice(1);

    return [
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
}

function normalizeTableCells(cells: TableCell[]): { cells: TableCell[]; rowCount: number; colCount: number } | null {
    if (cells.length === 0) {
        return null;
    }

    const rows = [...new Set(cells.map((cell) => cell.row))].sort((a, b) => a - b);
    const cols = [...new Set(cells.map((cell) => cell.col))].sort((a, b) => a - b);
    const rowIndex = new Map(rows.map((value, index) => [value, index]));
    const colIndex = new Map(cols.map((value, index) => [value, index]));

    const normalized = cells
        .map((cell) => {
            const row = rowIndex.get(cell.row);
            const col = colIndex.get(cell.col);
            if (row === undefined || col === undefined) {
                return null;
            }

            return { ...cell, row, col };
        })
        .filter((cell): cell is TableCell => cell !== null);

    if (normalized.length === 0) {
        return null;
    }

    return {
        cells: normalized,
        rowCount: rows.length,
        colCount: cols.length,
    };
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|").trim();
}

function extractWords(pageText: PageText): Word[] {
    const words: Word[] = [];

    for (let lineIndex = 0; lineIndex < pageText.lines.length; lineIndex += 1) {
        const line = pageText.lines[lineIndex];
        if (!line) {
            continue;
        }

        const chars = getPreparedLineChars(line);
        if (chars.length === 0) {
            const text = getNormalizedLineText(line);
            if (text) {
                words.push({ text, bbox: line.bbox, lineIndex });
            }
            continue;
        }

        if (inferLineDirection(line, chars) === "vertical") {
            const text = getNormalizedLineText(line);
            if (text) {
                words.push({ text, bbox: line.bbox, lineIndex });
            }
            continue;
        }

        let currentChars: TextChar[] = [];
        for (let index = 0; index < chars.length; index += 1) {
            const char = chars[index];
            if (!char) {
                continue;
            }

            const text = getExpandedCharText(char.char);

            if (text.trim().length === 0) {
                pushWord(words, currentChars, lineIndex);
                currentChars = [];
                continue;
            }

            if (isWordBoundaryPunctuation(text)) {
                pushWord(words, currentChars, lineIndex);
                pushWord(words, [{ ...char, char: text }], lineIndex);
                currentChars = [];
                continue;
            }

            const previous = currentChars[currentChars.length - 1];
            if (
                previous &&
                textCharBeginsNewWord(previous, char) &&
                !shouldKeepCharsJoined(previous, char, char.bbox.x - (previous.bbox.x + previous.bbox.width))
            ) {
                pushWord(words, currentChars, lineIndex);
                currentChars = [];
            }

            currentChars.push(char);
        }

        pushWord(words, currentChars, lineIndex);
    }

    return words;
}

function pushWord(words: Word[], chars: TextChar[], lineIndex: number): void {
    if (chars.length === 0) {
        return;
    }

    const text = normalizeWhitespace(reconstructTextFromChars(chars));
    if (!text) {
        return;
    }

    const bbox = unionBoxes(chars.map((char) => char.bbox));
    if (!bbox) {
        return;
    }

    words.push({ text, bbox, lineIndex });
}

function getNormalizedLineText(line: TextLine): string {
    const chars = getPreparedLineChars(line);
    if (chars.length === 0) {
        return normalizeWhitespace(line.text);
    }

    if (inferLineDirection(line, chars) === "vertical") {
        return reconstructVerticalTextFromChars(chars);
    }

    return normalizeWhitespace(cleanupExtractedTextSpacing(reconstructTextFromChars(chars)));
}

function getPreparedLineChars(line: TextLine): TextChar[] {
    return dedupeTextChars(
        sortTextChars(
            line.spans
                .flatMap((span) => span.chars)
                .filter((char) => char.char.length > 0 || char.bbox.width > 0 || char.bbox.height > 0)
        )
    );
}

function sortTextChars(chars: TextChar[]): TextChar[] {
    if (!chars.some((char) => typeof char.sequenceIndex === "number")) {
        return [...chars];
    }

    return [...chars].sort((left, right) => {
        if (typeof left.sequenceIndex === "number" && typeof right.sequenceIndex === "number") {
            if (left.sequenceIndex !== right.sequenceIndex) {
                return left.sequenceIndex - right.sequenceIndex;
            }
        }

        if (Math.abs(left.bbox.x - right.bbox.x) > 0.001) {
            return left.bbox.x - right.bbox.x;
        }

        if (Math.abs(left.fontSize - right.fontSize) > 0.001) {
            return right.fontSize - left.fontSize;
        }

        if (Math.abs(left.baseline - right.baseline) > 0.001) {
            return left.baseline - right.baseline;
        }

        return left.bbox.y - right.bbox.y;
    });
}

function dedupeTextChars(chars: TextChar[], tolerance = TEXT_CHAR_DEDUPE_TOLERANCE): TextChar[] {
    const buckets = new Map<string, TextChar[]>();
    const deduped: TextChar[] = [];

    for (const char of chars) {
        const key = [
            getExpandedCharText(char.char),
            char.fontName,
            Math.round(char.fontSize * 10),
            Math.round(char.baseline * 10),
        ].join("|");
        const seen = buckets.get(key) ?? [];
        if (seen.some((candidate) => isLikelyDuplicateTextChar(candidate, char, tolerance))) {
            continue;
        }

        seen.push(char);
        buckets.set(key, seen);
        deduped.push(char);
    }

    return deduped;
}

function isLikelyDuplicateTextChar(left: TextChar, right: TextChar, tolerance = TEXT_CHAR_DEDUPE_TOLERANCE): boolean {
    return (
        getExpandedCharText(left.char) === getExpandedCharText(right.char) &&
        Math.abs(left.bbox.x - right.bbox.x) <= tolerance &&
        Math.abs(left.bbox.y - right.bbox.y) <= tolerance &&
        Math.abs(left.bbox.width - right.bbox.width) <= tolerance &&
        Math.abs(left.bbox.height - right.bbox.height) <= tolerance &&
        Math.abs(left.baseline - right.baseline) <= tolerance
    );
}

function getExpandedCharText(value: string): string {
    return LIGATURE_EXPANSIONS[value] ?? value;
}

function isScriptLikeTextChar(previous: TextChar, current: TextChar): boolean {
    const smaller = current.fontSize <= previous.fontSize * 0.9 || previous.fontSize <= current.fontSize * 0.9;
    const baselineDelta = Math.abs(current.baseline - previous.baseline);
    const horizontalProximity =
        current.bbox.x <= previous.bbox.x + previous.bbox.width + Math.max(current.bbox.width, 2);
    return smaller && horizontalProximity && baselineDelta >= Math.min(previous.fontSize, current.fontSize) * 0.15;
}

function shouldTightlyJoinChars(previous: TextChar, current: TextChar): boolean {
    if (isScriptLikeTextChar(previous, current)) {
        return true;
    }

    const left = getExpandedCharText(previous.char);
    const right = getExpandedCharText(current.char);
    return /^[([{]$/.test(left) || /^[)\]}]$/.test(right);
}

function cleanupExtractedTextSpacing(value: string): string {
    return value
        .replace(/\s+([,;:!?])/g, "$1")
        .replace(/\s+\.(?!\.)/g, ".")
        .replace(/([([{])\s+/g, "$1")
        .replace(/\s+([)\]}])/g, "$1")
        .trim();
}

function getAdaptiveTextXTolerance(previous: TextChar, current: TextChar): number {
    return Math.max(
        TEXT_DEFAULT_X_TOLERANCE,
        previous.fontSize * TEXT_DEFAULT_X_TOLERANCE_RATIO,
        current.fontSize * TEXT_DEFAULT_X_TOLERANCE_RATIO,
        Math.max(previous.bbox.width, current.bbox.width) * 0.75
    );
}

function getAdaptiveTextYTolerance(previous: TextChar, current: TextChar): number {
    return Math.max(
        TEXT_DEFAULT_Y_TOLERANCE,
        Math.min(previous.fontSize, current.fontSize) * TEXT_DEFAULT_Y_TOLERANCE_RATIO
    );
}

function textCharBeginsNewWord(previous: TextChar, current: TextChar): boolean {
    if (isScriptLikeTextChar(previous, current)) {
        return false;
    }

    const direction = inferTextCharDirection(previous);
    const xTolerance = getAdaptiveTextXTolerance(previous, current);
    const yTolerance = getAdaptiveTextYTolerance(previous, current);

    if (direction === "vertical") {
        const ax = previous.bbox.y;
        const bx = getTop(previous.bbox);
        const cx = current.bbox.y;
        const ay = previous.bbox.x;
        const cy = current.bbox.x;
        return cx < ax - xTolerance * 0.25 || cx > bx + xTolerance || Math.abs(cy - ay) > yTolerance;
    }

    const ax = previous.bbox.x;
    const bx = previous.bbox.x + previous.bbox.width;
    const cx = current.bbox.x;
    const ay = previous.bbox.y;
    const cy = current.bbox.y;
    return cx < ax - xTolerance * 0.25 || cx > bx + xTolerance || Math.abs(cy - ay) > yTolerance;
}

function isWordBoundaryPunctuation(text: string): boolean {
    return text.length === 1 && WORD_BOUNDARY_PUNCTUATION.has(text);
}

function isInlineTokenConnector(text: string): boolean {
    return text.length === 1 && INLINE_TOKEN_CONNECTORS.has(text);
}

function shouldKeepCharsJoined(previous: TextChar, current: TextChar, gap: number): boolean {
    if (shouldTightlyJoinChars(previous, current)) {
        return true;
    }

    const left = getExpandedCharText(previous.char);
    const right = getExpandedCharText(current.char);
    const joinTolerance = getAdaptiveTextXTolerance(previous, current) * 1.35;

    if ((isInlineTokenConnector(left) || isInlineTokenConnector(right)) && gap <= joinTolerance) {
        return true;
    }

    if (
        ((/^[A-Za-z]$/.test(left) && /^\d+$/.test(right)) || (/^\d+$/.test(left) && /^[A-Za-z]$/.test(right))) &&
        gap <= joinTolerance
    ) {
        return true;
    }

    return false;
}

function shouldInsertSpaceBetweenChars(previous: TextChar, current: TextChar, gap: number): boolean {
    if (gap <= 0 || shouldKeepCharsJoined(previous, current, gap)) {
        return false;
    }

    return textCharBeginsNewWord(previous, current);
}

function analyzePageContent(pdf: PDFDocumentLike, page: PDFPageLike, nextImageId: () => string): PageContentAnalysis {
    const occurrences: ImageOccurrence[] = [];
    const explicitEdges: Edge[] = [];
    const actualTextSpans: ActualTextSpan[] = [];
    const resolver = pdf.getObject.bind(pdf);
    const resources = page.getResources();
    const contentStreams = getContentStreams(page.dict.get("Contents", resolver), resolver);
    const initialState: GraphicsState = {
        ctm: cloneMatrix(IDENTITY_MATRIX),
        lineWidth: DEFAULT_LINE_WIDTH,
        path: createEmptyPathState(),
    };
    const markedContentState: MarkedContentState = {
        stack: [],
        textSequenceIndex: 0,
    };

    for (const stream of contentStreams) {
        const decoded = safelyDecodeStream(stream);
        scanContentStream({
            pdf,
            pageIndex: page.index,
            resources,
            bytes: decoded,
            nextImageId,
            occurrences,
            explicitEdges,
            actualTextSpans,
            state: cloneGraphicsState(initialState),
            markedContentState,
        });
    }

    return {
        images: occurrences,
        explicitEdges: mergeEdges(explicitEdges),
        actualTextSpans,
    };
}

function getContentStreams(object: unknown, resolver?: (ref: PDFRefLike) => unknown): PDFStreamLike[] {
    if (isPDFStream(object)) {
        return [object];
    }

    if (isPDFArray(object)) {
        const streams: PDFStreamLike[] = [];
        for (let index = 0; index < object.length; index += 1) {
            const entry = object.at(index, resolver);
            streams.push(...getContentStreams(entry, resolver));
        }

        return streams;
    }

    return [];
}

function safelyDecodeStream(stream: PDFStreamLike): Uint8Array {
    try {
        return stream.getDecodedData();
    } catch {
        return stream.data;
    }
}

function scanContentStream(options: {
    pdf: PDFDocumentLike;
    pageIndex: number;
    resources: PDFDictLike | undefined;
    bytes: Uint8Array;
    nextImageId: () => string;
    occurrences: ImageOccurrence[];
    explicitEdges: Edge[];
    actualTextSpans: ActualTextSpan[];
    state: GraphicsState;
    markedContentState: MarkedContentState;
}): void {
    const {
        pdf,
        pageIndex,
        resources,
        bytes,
        nextImageId,
        occurrences,
        explicitEdges,
        actualTextSpans,
        markedContentState,
    } = options;
    const stack: GraphicsState[] = [];
    let state = cloneGraphicsState(options.state);
    let operands: Operand[] = [];
    const tokenizer = createTokenizer(bytes);

    while (true) {
        const token = tokenizer.next();
        if (!token) {
            break;
        }

        if (token.kind === "operand") {
            operands.push(token.value);
            continue;
        }

        const operator = token.value;
        switch (operator) {
            case "q":
                stack.push(cloneGraphicsState(state));
                break;
            case "Q": {
                const previous = stack.pop();
                state = previous ? previous : cloneGraphicsState(options.state);
                break;
            }
            case "cm": {
                const matrix = operandMatrix(operands);
                if (matrix) {
                    state.ctm = multiplyMatrices(state.ctm, matrix);
                }
                break;
            }
            case "w": {
                const width = operandNumber(operands.at(0));
                if (width !== null) {
                    state.lineWidth = width;
                }
                break;
            }
            case "m": {
                const x = operandNumber(operands.at(0));
                const y = operandNumber(operands.at(1));
                if (x !== null && y !== null) {
                    state.path.currentPoint = { x, y };
                }
                break;
            }
            case "l": {
                const x = operandNumber(operands.at(0));
                const y = operandNumber(operands.at(1));
                if (x !== null && y !== null && state.path.currentPoint) {
                    state.path.subpaths.push({
                        x0: state.path.currentPoint.x,
                        y0: state.path.currentPoint.y,
                        x1: x,
                        y1: y,
                        width: state.lineWidth,
                    });
                    state.path.currentPoint = { x, y };
                }
                break;
            }
            case "re": {
                const x = operandNumber(operands.at(0));
                const y = operandNumber(operands.at(1));
                const width = operandNumber(operands.at(2));
                const height = operandNumber(operands.at(3));
                if (x !== null && y !== null && width !== null && height !== null) {
                    state.path.rectangles.push({ x, y, width, height });
                    state.path.currentPoint = { x, y };
                }
                break;
            }
            case "h": {
                state.path.currentPoint = null;
                break;
            }
            case "S":
            case "s":
            case "f":
            case "F":
            case "f*":
            case "B":
            case "B*":
            case "b":
            case "b*":
                explicitEdges.push(...pathToEdges(state.path, state.ctm));
                state.path = createEmptyPathState();
                break;
            case "n":
            case "W":
            case "W*":
                state.path = createEmptyPathState();
                break;
            case "Do": {
                const name = operandName(operands.at(0));
                if (name && resources) {
                    handlePaintedObject({
                        pdf,
                        pageIndex,
                        resources,
                        name,
                        ctm: state.ctm,
                        nextImageId,
                        occurrences,
                        explicitEdges,
                        actualTextSpans,
                        markedContentState,
                    });
                }
                break;
            }
            case "BMC":
            case "BDC": {
                const tag = operandName(operands[0]);
                const propsOperand = operator === "BDC" ? operands[1] : undefined;
                const properties = resolveMarkedContentProperties(propsOperand, resources, pdf);
                markedContentState.stack.push({
                    tag,
                    mcid: operandInteger(properties?.MCID),
                    actualText: extractActualTextFromMarkedContent(properties),
                    startSequenceIndex: null,
                    endSequenceIndex: null,
                });
                break;
            }
            case "EMC": {
                const entry = markedContentState.stack.pop();
                if (entry?.actualText && entry.startSequenceIndex !== null && entry.endSequenceIndex !== null) {
                    actualTextSpans.push({
                        startSequenceIndex: entry.startSequenceIndex,
                        endSequenceIndex: entry.endSequenceIndex,
                        text: entry.actualText,
                        tag: entry.tag,
                        mcid: entry.mcid,
                    });
                }
                break;
            }
            case "Tj":
            case "'": {
                registerTextSequenceAdvance(markedContentState, countRenderedTextItems(operands[0]));
                break;
            }
            case '"': {
                registerTextSequenceAdvance(markedContentState, countRenderedTextItems(operands[2]));
                break;
            }
            case "TJ": {
                registerTextSequenceAdvance(markedContentState, countRenderedTextItems(operands[0]));
                break;
            }
            default:
                break;
        }

        operands = [];
    }
}

function handlePaintedObject(options: {
    pdf: PDFDocumentLike;
    pageIndex: number;
    resources: PDFDictLike;
    name: string;
    ctm: Matrix2D;
    nextImageId: () => string;
    occurrences: ImageOccurrence[];
    explicitEdges: Edge[];
    actualTextSpans: ActualTextSpan[];
    markedContentState: MarkedContentState;
}): void {
    const {
        pdf,
        pageIndex,
        resources,
        name,
        ctm,
        nextImageId,
        occurrences,
        explicitEdges,
        actualTextSpans,
        markedContentState,
    } = options;
    const resolver = pdf.getObject.bind(pdf);
    const xObjects = resources.getDict("XObject", resolver);
    if (!xObjects) {
        return;
    }

    const raw = xObjects.get(name, resolver);
    if (!isPDFStream(raw)) {
        return;
    }

    const subtype = raw.getName("Subtype", resolver)?.value;
    if (subtype === "Image") {
        const bbox = transformUnitSquare(ctm);
        occurrences.push({
            id: nextImageId(),
            type: getImageMimeType(raw, resolver),
            content: safelyDecodeStream(raw),
            bbox,
            pageIndex,
        });
        return;
    }

    if (subtype !== "Form") {
        return;
    }

    const formMatrix = getMatrixFromArray(raw.getArray("Matrix", resolver)) || cloneMatrix(IDENTITY_MATRIX);
    const formResources = raw.getDict("Resources", resolver) || resources;
    const decoded = safelyDecodeStream(raw);

    scanContentStream({
        pdf,
        pageIndex,
        resources: formResources,
        bytes: decoded,
        nextImageId,
        occurrences,
        explicitEdges,
        actualTextSpans,
        state: {
            ctm: multiplyMatrices(ctm, formMatrix),
            lineWidth: DEFAULT_LINE_WIDTH,
            path: createEmptyPathState(),
        },
        markedContentState,
    });
}

function resolveMarkedContentProperties(
    operand: Operand | undefined,
    resources: PDFDictLike | undefined,
    pdf: PDFDocumentLike
): OperandDictionary | null {
    if (isOperandDictionary(operand)) {
        return operand;
    }

    const name = operandName(operand);
    if (!name || !resources) {
        return null;
    }

    const resolver = pdf.getObject.bind(pdf);
    const propertyDict = resources.getDict("Properties", resolver);
    const raw = propertyDict?.get(name, resolver);
    return pdfObjectToOperand(raw, resolver);
}

function extractActualTextFromMarkedContent(properties: OperandDictionary | null): string | null {
    const raw = properties?.ActualText;
    const text = decodePDFTextOperand(raw);
    return text ? normalizeWhitespace(text) : null;
}

function registerTextSequenceAdvance(state: MarkedContentState, count: number): void {
    if (count <= 0) {
        return;
    }

    const active = getActiveActualTextEntry(state.stack);
    if (active) {
        if (active.startSequenceIndex === null) {
            active.startSequenceIndex = state.textSequenceIndex;
        }
        active.endSequenceIndex = state.textSequenceIndex + count - 1;
    }

    state.textSequenceIndex += count;
}

function getActiveActualTextEntry(stack: MarkedContentEntry[]): MarkedContentEntry | null {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        const entry = stack[index];
        if (entry?.actualText) {
            return entry;
        }
    }

    return null;
}

function countRenderedTextItems(value: Operand | undefined): number {
    if (typeof value === "string") {
        return Array.from(value).length;
    }

    if (value instanceof Uint8Array) {
        const decoded = decodePDFStringBytes(value);
        return decoded ? Array.from(decoded).length : value.length;
    }

    if (Array.isArray(value)) {
        let total = 0;
        for (const item of value) {
            total += countRenderedTextItems(item);
        }
        return total;
    }

    return 0;
}

function decodePDFTextOperand(value: Operand | undefined): string | null {
    if (typeof value === "string") {
        return value;
    }

    if (value instanceof Uint8Array) {
        return decodePDFStringBytes(value);
    }

    return null;
}

function decodePDFStringBytes(bytes: Uint8Array): string {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        let output = "";
        for (let index = 2; index + 1 < bytes.length; index += 2) {
            output += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
        }
        return output;
    }

    return Buffer.from(bytes).toString("latin1");
}

function operandInteger(value: Operand | undefined): number | null {
    return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isOperandDictionary(value: Operand | undefined): value is OperandDictionary {
    return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function pdfObjectToOperand(object: unknown, resolver?: (ref: PDFRefLike) => unknown): OperandDictionary | null {
    if (!isPDFDict(object)) {
        return null;
    }

    const out: OperandDictionary = {};
    for (const [key, value] of object) {
        out[key.value] = pdfValueToOperand(value, resolver);
    }

    return out;
}

function pdfValueToOperand(value: unknown, resolver?: (ref: PDFRefLike) => unknown): Operand {
    if (isPDFRef(value) && resolver) {
        return pdfValueToOperand(resolver(value), resolver);
    }
    if (typeof value === "number" || typeof value === "string" || value instanceof Uint8Array || value === null) {
        return value;
    }
    if (isPDFStringLike(value)) {
        return value.bytes ?? null;
    }
    if (isPDFNumber(value)) {
        return value.value;
    }
    if (isPDFName(value)) {
        return value.value;
    }
    if (isPDFArray(value)) {
        const items: Operand[] = [];
        for (let index = 0; index < value.length; index += 1) {
            items.push(pdfValueToOperand(value.at(index, resolver), resolver));
        }
        return items;
    }
    if (isPDFDict(value)) {
        return pdfObjectToOperand(value, resolver);
    }

    return null;
}

function transformUnitSquare(matrix: Matrix2D): BoundingBox {
    const points = [
        transformPoint(matrix, 0, 0),
        transformPoint(matrix, 1, 0),
        transformPoint(matrix, 0, 1),
        transformPoint(matrix, 1, 1),
    ];

    return boundingBoxFromPoints(points);
}

function pathToEdges(path: PathState, matrix: Matrix2D): Edge[] {
    const edges: Edge[] = [];

    for (const segment of path.subpaths) {
        const start = transformPoint(matrix, segment.x0, segment.y0);
        const end = transformPoint(matrix, segment.x1, segment.y1);
        const edge = pointsToEdge(start, end, "explicit");
        if (edge) {
            edges.push(edge);
        }
    }

    for (const rectangle of path.rectangles) {
        const points = [
            transformPoint(matrix, rectangle.x, rectangle.y),
            transformPoint(matrix, rectangle.x + rectangle.width, rectangle.y),
            transformPoint(matrix, rectangle.x + rectangle.width, rectangle.y + rectangle.height),
            transformPoint(matrix, rectangle.x, rectangle.y + rectangle.height),
        ];

        for (let index = 0; index < points.length; index += 1) {
            const start = points[index];
            const end = points[(index + 1) % points.length];
            if (!start || !end) {
                continue;
            }

            const edge = pointsToEdge(start, end, "explicit");
            if (edge) {
                edges.push(edge);
            }
        }
    }

    return edges;
}

function pointsToEdge(
    start: { x: number; y: number },
    end: { x: number; y: number },
    source: Edge["source"]
): Edge | null {
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    if (dx <= EDGE_SNAP_TOLERANCE && dy >= EDGE_MIN_LENGTH) {
        return {
            orientation: "vertical",
            position: average([start.x, end.x]),
            start: Math.min(start.y, end.y),
            end: Math.max(start.y, end.y),
            source,
        };
    }

    if (dy <= EDGE_SNAP_TOLERANCE && dx >= EDGE_MIN_LENGTH) {
        return {
            orientation: "horizontal",
            position: average([start.y, end.y]),
            start: Math.min(start.x, end.x),
            end: Math.max(start.x, end.x),
            source,
        };
    }

    return null;
}

function createTokenizer(bytes: Uint8Array): {
    next: () => { kind: "operand"; value: Operand } | { kind: "operator"; value: string } | null;
} {
    const text = new TextDecoder().decode(bytes);
    let index = 0;

    function charAt(position: number): string {
        return text[position] ?? "";
    }

    function skipWhitespace(): void {
        while (index < text.length) {
            const char = charAt(index);
            if (char === "%") {
                while (index < text.length && charAt(index) !== "\n" && charAt(index) !== "\r") {
                    index += 1;
                }
                continue;
            }

            if (!/\s/.test(char)) {
                break;
            }

            index += 1;
        }
    }

    function readNumberOrWord(): { kind: "operand"; value: Operand } | { kind: "operator"; value: string } {
        const start = index;
        while (index < text.length && !/\s/.test(charAt(index)) && !"[]<>{}/()%".includes(charAt(index))) {
            index += 1;
        }

        const value = text.slice(start, index);
        if (/^[+-]?(?:\d+\.\d+|\d+|\.\d+)$/.test(value)) {
            return { kind: "operand", value: Number(value) };
        }

        if (value === "true" || value === "false" || value === "null") {
            return { kind: "operand", value: null };
        }

        return { kind: "operator", value };
    }

    function readName(): { kind: "operand"; value: Operand } {
        index += 1;
        const start = index;
        while (index < text.length && !/\s/.test(charAt(index)) && !"[]<>{}/()%".includes(charAt(index))) {
            index += 1;
        }

        return { kind: "operand", value: text.slice(start, index) };
    }

    function readLiteralString(): { kind: "operand"; value: Operand } {
        index += 1;
        let depth = 1;
        let result = "";

        while (index < text.length && depth > 0) {
            const char = charAt(index);
            index += 1;

            if (char === "\\") {
                if (index >= text.length) {
                    break;
                }

                const escaped = charAt(index);
                index += 1;
                switch (escaped) {
                    case "n":
                        result += "\n";
                        break;
                    case "r":
                        result += "\r";
                        break;
                    case "t":
                        result += "\t";
                        break;
                    case "b":
                        result += "\b";
                        break;
                    case "f":
                        result += "\f";
                        break;
                    case "(":
                    case ")":
                    case "\\":
                        result += escaped;
                        break;
                    case "\r":
                        if (charAt(index) === "\n") {
                            index += 1;
                        }
                        break;
                    case "\n":
                        break;
                    default:
                        if (/[0-7]/.test(escaped)) {
                            let octal = escaped;
                            while (octal.length < 3 && index < text.length && /[0-7]/.test(charAt(index))) {
                                octal += charAt(index);
                                index += 1;
                            }
                            result += String.fromCharCode(parseInt(octal, 8));
                        } else {
                            result += escaped;
                        }
                        break;
                }
                continue;
            }

            if (char === "(") {
                depth += 1;
                result += char;
                continue;
            }

            if (char === ")") {
                depth -= 1;
                if (depth > 0) {
                    result += char;
                }
                continue;
            }

            result += char;
        }

        return { kind: "operand", value: result };
    }

    function readHexString(): { kind: "operand"; value: Operand } {
        index += 1;
        const start = index;
        while (index < text.length && charAt(index) !== ">") {
            index += 1;
        }
        const raw = text.slice(start, index).replace(/\s+/g, "");
        if (index < text.length && charAt(index) === ">") {
            index += 1;
        }

        const normalized = raw.length % 2 === 0 ? raw : `${raw}0`;
        const bytes = new Uint8Array(normalized.length / 2);
        for (let byteIndex = 0; byteIndex < normalized.length; byteIndex += 2) {
            bytes[byteIndex / 2] = Number.parseInt(normalized.slice(byteIndex, byteIndex + 2), 16);
        }

        return { kind: "operand", value: bytes };
    }

    function readArray(): { kind: "operand"; value: Operand } {
        index += 1;
        const values: Operand[] = [];

        while (index < text.length) {
            skipWhitespace();
            if (charAt(index) === "]") {
                index += 1;
                break;
            }

            const value = readOperandValue();
            if (value === undefined) {
                break;
            }
            values.push(value);
        }

        return { kind: "operand", value: values };
    }

    function readDictionaryOperand(): { kind: "operand"; value: Operand } {
        index += 2;
        const values: OperandDictionary = {};

        while (index < text.length) {
            skipWhitespace();
            if (charAt(index) === ">" && charAt(index + 1) === ">") {
                index += 2;
                break;
            }

            const keyToken = readName();
            const key = typeof keyToken.value === "string" ? keyToken.value : null;
            if (!key) {
                break;
            }

            skipWhitespace();
            values[key] = readOperandValue() ?? null;
        }

        return { kind: "operand", value: values };
    }

    function readOperandValue(): Operand | undefined {
        skipWhitespace();
        if (index >= text.length) {
            return undefined;
        }

        const char = charAt(index);
        if (char === "/") {
            return readName().value;
        }

        if (char === "(") {
            return readLiteralString().value;
        }

        if (char === "[") {
            return readArray().value;
        }

        if (char === "<" && charAt(index + 1) === "<") {
            return readDictionaryOperand().value;
        }

        if (char === "<") {
            return readHexString().value;
        }

        const token = readNumberOrWord();
        return token.kind === "operand" ? token.value : null;
    }

    function next(): { kind: "operand"; value: Operand } | { kind: "operator"; value: string } | null {
        skipWhitespace();
        if (index >= text.length) {
            return null;
        }

        const char = charAt(index);
        if (char === "/") {
            return readName();
        }

        if (char === "(") {
            return readLiteralString();
        }

        if (char === "[") {
            return readArray();
        }

        if (char === "<" && charAt(index + 1) === "<") {
            return readDictionaryOperand();
        }

        if (char === "<") {
            return readHexString();
        }

        return readNumberOrWord();
    }

    return { next };
}

function operandNumber(value: Operand | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function operandName(value: Operand | undefined): string | null {
    return typeof value === "string" ? value : null;
}

function operandMatrix(values: Operand[]): Matrix2D | null {
    if (values.length < 6) {
        return null;
    }

    const numbers = values.slice(-6).map(operandNumber);
    if (numbers.some((value) => value === null)) {
        return null;
    }

    return {
        a: numbers[0] as number,
        b: numbers[1] as number,
        c: numbers[2] as number,
        d: numbers[3] as number,
        e: numbers[4] as number,
        f: numbers[5] as number,
    };
}

function multiplyMatrices(left: Matrix2D, right: Matrix2D): Matrix2D {
    return {
        a: left.a * right.a + left.b * right.c,
        b: left.a * right.b + left.b * right.d,
        c: left.c * right.a + left.d * right.c,
        d: left.c * right.b + left.d * right.d,
        e: left.e * right.a + left.f * right.c + right.e,
        f: left.e * right.b + left.f * right.d + right.f,
    };
}

function transformPoint(matrix: Matrix2D, x: number, y: number): { x: number; y: number } {
    return {
        x: matrix.a * x + matrix.c * y + matrix.e,
        y: matrix.b * x + matrix.d * y + matrix.f,
    };
}

function cloneMatrix(matrix: Matrix2D): Matrix2D {
    return { ...matrix };
}

function cloneGraphicsState(state: GraphicsState): GraphicsState {
    return {
        ctm: cloneMatrix(state.ctm),
        lineWidth: state.lineWidth,
        path: {
            currentPoint: state.path.currentPoint ? { ...state.path.currentPoint } : null,
            subpaths: state.path.subpaths.map((line) => ({ ...line })),
            rectangles: state.path.rectangles.map((rectangle) => ({ ...rectangle })),
        },
    };
}

function createEmptyPathState(): PathState {
    return {
        currentPoint: null,
        subpaths: [],
        rectangles: [],
    };
}

function getMatrixFromArray(array: PDFArrayLike | undefined): Matrix2D | null {
    if (!array || array.length < 6) {
        return null;
    }

    const values: number[] = [];
    for (let index = 0; index < 6; index += 1) {
        const item = array.at(index);
        if (!isPDFNumber(item)) {
            return null;
        }

        values.push(item.value);
    }

    const [a, b, c, d, e, f] = values;
    if (
        a === undefined ||
        b === undefined ||
        c === undefined ||
        d === undefined ||
        e === undefined ||
        f === undefined
    ) {
        return null;
    }

    return { a, b, c, d, e, f };
}

function isPDFArray(value: unknown): value is PDFArrayLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "array";
}

function isPDFStream(value: unknown): value is PDFStreamLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "stream";
}

function isPDFName(value: unknown): value is PDFNameLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "name";
}

function isPDFStringLike(value: unknown): value is { type: "string"; bytes?: Uint8Array } {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "string";
}

function isPDFRef(value: unknown): value is PDFRefLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "ref";
}

function isPDFDict(value: unknown): value is PDFDictLike {
    const type = typeof value === "object" && value !== null ? (value as { type?: string }).type : null;
    return type === "dict" || type === "stream";
}

function isPDFNumber(value: unknown): value is PDFNumberLike {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "number";
}

function getImageMimeType(stream: PDFStreamLike, resolver?: (ref: PDFRefLike) => unknown): string {
    const filter = stream.get("Filter", resolver);
    const filterNames = getPDFFilterNames(filter, resolver);

    if (filterNames.includes("DCTDecode") || filterNames.includes("JPXDecode")) {
        return "image/jpeg";
    }

    if (filterNames.includes("FlateDecode")) {
        return "image/png";
    }

    const bytes = safelyDecodeStream(stream);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        return "image/jpeg";
    }

    if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return "image/png";
    }

    return "image/png";
}

function getPDFFilterNames(value: unknown, resolver?: (ref: PDFRefLike) => unknown): string[] {
    if (isPDFName(value)) {
        return [value.value];
    }

    if (!isPDFArray(value)) {
        return [];
    }

    const names: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const entry = value.at(index, resolver);
        if (isPDFName(entry)) {
            names.push(entry.value);
        }
    }

    return names;
}

function getTop(bbox: BoundingBox): number {
    return bbox.y + bbox.height;
}

function overlapLength(startA: number, endA: number, startB: number, endB: number): number {
    return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function intersects(a: BoundingBox, b: BoundingBox, threshold = 0): boolean {
    const xOverlap = overlapLength(a.x, a.x + a.width, b.x, b.x + b.width);
    const yOverlap = overlapLength(a.y, getTop(a), b.y, getTop(b));
    if (xOverlap <= 0 || yOverlap <= 0) {
        return false;
    }

    if (threshold <= 0) {
        return true;
    }

    const overlapArea = xOverlap * yOverlap;
    const minArea = Math.min(a.width * a.height, b.width * b.height);
    return overlapArea / Math.max(minArea, 1) >= threshold;
}

function intersectsAny(bbox: BoundingBox, regions: BoundingBox[], threshold = 0): boolean {
    return regions.some((region) => intersects(bbox, region, threshold));
}

function unionBoxes(boxes: BoundingBox[]): BoundingBox | null {
    if (boxes.length === 0) {
        return null;
    }

    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

function boundingBoxFromPoints(points: Array<{ x: number; y: number }>): BoundingBox {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

function uniqueSorted(values: number[]): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const unique: number[] = [];

    for (const value of sorted) {
        const last = unique.at(-1);
        if (last === undefined || Math.abs(last - value) > EDGE_SNAP_TOLERANCE) {
            unique.push(value);
        } else {
            unique[unique.length - 1] = average([last, value]);
        }
    }

    return unique;
}

function median(values: number[]): number | null {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? null;
    }

    const left = sorted[middle - 1];
    const right = sorted[middle];
    if (left === undefined || right === undefined) {
        return null;
    }

    return (left + right) / 2;
}

function average(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function tableDefaultSettings(): TableSettings {
    return {
        VerticalStrategy: "lines",
        HorizontalStrategy: "lines",
        ExplicitVerticalLines: [],
        ExplicitHorizontalLines: [],
        MinRows: TABLE_MIN_ROWS,
        MinCols: TABLE_MIN_COLS,
        SnapTolerance: TABLE_DEFAULT_SNAP_TOLERANCE,
        SnapXTolerance: TABLE_DEFAULT_SNAP_TOLERANCE,
        SnapYTolerance: TABLE_DEFAULT_SNAP_TOLERANCE,
        JoinTolerance: TABLE_DEFAULT_JOIN_TOLERANCE,
        JoinXTolerance: TABLE_DEFAULT_JOIN_TOLERANCE,
        JoinYTolerance: TABLE_DEFAULT_JOIN_TOLERANCE,
        EdgeMinLength: TABLE_DEFAULT_EDGE_MIN_LENGTH,
        EdgeMinLengthPrefilt: TABLE_DEFAULT_EDGE_MIN_PREFILT,
        MinWordsVertical: TABLE_DEFAULT_MIN_WORDS_VERTICAL,
        MinWordsHorizontal: TABLE_DEFAULT_MIN_WORDS_HORIZONTAL,
        IntersectionTolerance: TABLE_DEFAULT_INTERSECTION_TOLERANCE,
        IntersectionXTol: TABLE_DEFAULT_INTERSECTION_TOLERANCE,
        IntersectionYTol: TABLE_DEFAULT_INTERSECTION_TOLERANCE,
        TextTolerance: TABLE_DEFAULT_TEXT_TOLERANCE,
    };
}

function tableSettingsForStrategy(
    vertical: TableSettings["VerticalStrategy"],
    horizontal: TableSettings["HorizontalStrategy"]
): TableSettings {
    return {
        ...tableDefaultSettings(),
        VerticalStrategy: vertical,
        HorizontalStrategy: horizontal,
    };
}

function buildTablePage(pageText: PageText, words: Word[], explicitEdges: Edge[]): TablePage {
    const tableChars = pageText.lines.flatMap((line) =>
        getPreparedLineChars(line).map((char) => ({
            text: getExpandedCharText(char.char),
            x0: char.bbox.x,
            x1: char.bbox.x + char.bbox.width,
            top: pageText.height - getTop(char.bbox),
            bottom: pageText.height - char.bbox.y,
            fontSize: char.fontSize,
            fontName: char.fontName,
            baseline: pageText.height - char.baseline,
            sequenceIndex: char.sequenceIndex,
        }))
    );

    return {
        bbox: {
            x0: 0,
            top: 0,
            x1: Math.max(
                0,
                ...words.map((word) => word.bbox.x + word.bbox.width),
                ...tableChars.map((char) => char.x1)
            ),
            bottom: pageText.height,
        },
        words: words.map((word) => ({
            text: word.text,
            x0: word.bbox.x,
            x1: word.bbox.x + word.bbox.width,
            top: pageText.height - getTop(word.bbox),
            bottom: pageText.height - word.bbox.y,
            lineIndex: word.lineIndex,
        })),
        chars: tableChars,
        edges: explicitEdges.map((edge) => tableEdgeFromLayoutEdge(edge, pageText.height)),
    };
}

function tableEdgeFromLayoutEdge(edge: Edge, pageHeight: number): TableEdge {
    if (edge.orientation === "vertical") {
        return {
            objectType: "line",
            orientation: "v",
            x0: edge.position,
            x1: edge.position,
            top: pageHeight - edge.end,
            bottom: pageHeight - edge.start,
            width: 0,
            height: edge.end - edge.start,
        };
    }

    return {
        objectType: "line",
        orientation: "h",
        x0: edge.start,
        x1: edge.end,
        top: pageHeight - edge.position,
        bottom: pageHeight - edge.position,
        width: edge.end - edge.start,
        height: 0,
    };
}

function tableFindTables(page: TablePage, settings: TableSettings): TableModelData[] {
    const edges = tableGetTableEdges(page, settings);
    const intersections = tableEdgesToIntersections(edges, settings.IntersectionXTol, settings.IntersectionYTol);
    const cells = tableIntersectionsToCells(intersections);
    const tables = tableFilterTablesByStructure(tableCellsToTables(cells), settings.MinRows, settings.MinCols);
    return tables.map((cellsGroup) => ({ page, cells: cellsGroup }));
}

function tableGetTableEdges(page: TablePage, settings: TableSettings): TableEdge[] {
    const verticalExplicit = settings.ExplicitVerticalLines.map((x) => ({
        objectType: "line",
        orientation: "v" as const,
        x0: x,
        x1: x,
        top: page.bbox.top,
        bottom: page.bbox.bottom,
        width: 0,
        height: page.bbox.bottom - page.bbox.top,
    }));
    const horizontalExplicit = settings.ExplicitHorizontalLines.map((y) => ({
        objectType: "line",
        orientation: "h" as const,
        x0: page.bbox.x0,
        x1: page.bbox.x1,
        top: y,
        bottom: y,
        width: page.bbox.x1 - page.bbox.x0,
        height: 0,
    }));

    let verticalBase: TableEdge[] = [];
    if (settings.VerticalStrategy === "lines") {
        verticalBase = tableFilterEdges(page.edges, "v", "", settings.EdgeMinLengthPrefilt);
    } else if (settings.VerticalStrategy === "lines_strict") {
        verticalBase = tableFilterEdges(page.edges, "v", "line", settings.EdgeMinLengthPrefilt);
    } else if (settings.VerticalStrategy === "text") {
        verticalBase = tableWordsToEdgesV(page.words, settings.MinWordsVertical);
    }

    let horizontalBase: TableEdge[] = [];
    if (settings.HorizontalStrategy === "lines") {
        horizontalBase = tableFilterEdges(page.edges, "h", "", settings.EdgeMinLengthPrefilt);
    } else if (settings.HorizontalStrategy === "lines_strict") {
        horizontalBase = tableFilterEdges(page.edges, "h", "line", settings.EdgeMinLengthPrefilt);
    } else if (settings.HorizontalStrategy === "text") {
        horizontalBase = tableWordsToEdgesH(page.words, settings.MinWordsHorizontal);
    }

    let edges = [...verticalBase, ...verticalExplicit, ...horizontalBase, ...horizontalExplicit];
    edges = tableMergeEdges(
        edges,
        settings.SnapXTolerance,
        settings.SnapYTolerance,
        settings.JoinXTolerance,
        settings.JoinYTolerance
    );
    edges = tableFilterEdges(edges, "", "", settings.EdgeMinLength);

    let verticalEdges = tableFilterEdges(edges, "v", "", 0);
    let horizontalEdges = tableFilterEdges(edges, "h", "", 0);

    if (settings.HorizontalStrategy === "text" && settings.VerticalStrategy !== "text") {
        horizontalEdges = tableExtendEdgesToNeighbors(horizontalEdges, verticalEdges, "h", settings.IntersectionXTol);
    }
    if (settings.VerticalStrategy === "text" && settings.HorizontalStrategy !== "text") {
        verticalEdges = tableExtendEdgesToNeighbors(verticalEdges, horizontalEdges, "v", settings.IntersectionYTol);
    }

    return [...verticalEdges, ...horizontalEdges];
}

function tableExtendEdgesToNeighbors(
    edgesToExtend: TableEdge[],
    other: TableEdge[],
    orientation: "h" | "v",
    intersectionTolerance: number
): TableEdge[] {
    const out = edgesToExtend.map((edge) => ({ ...edge }));
    if (out.length === 0 || other.length < 2) {
        return out;
    }

    for (let index = 0; index < out.length; index += 1) {
        const edge = out[index];
        if (!edge) {
            continue;
        }

        let loc = orientation === "h" ? edge.top : edge.x0;
        let first = orientation === "h" ? edge.x0 : edge.top;
        let second = orientation === "h" ? edge.x1 : edge.bottom;

        const coords = other
            .filter((candidate) => {
                const start = orientation === "h" ? candidate.top : candidate.x0;
                const end = orientation === "h" ? candidate.bottom : candidate.x1;
                return loc >= start - intersectionTolerance && loc <= end + intersectionTolerance;
            })
            .map((candidate) => (orientation === "h" ? candidate.x0 : candidate.top))
            .sort((a, b) => a - b);

        if (coords.length <= 1) {
            continue;
        }

        for (let coordIndex = 0; coordIndex < coords.length; coordIndex += 1) {
            const coord = coords[coordIndex];
            if (coord === undefined) {
                continue;
            }

            if (first - coord < -intersectionTolerance) {
                if (coordIndex > 0) {
                    first = coords[coordIndex - 1] ?? first;
                }
                break;
            }
        }

        for (let coordIndex = coords.length - 1; coordIndex >= 0; coordIndex -= 1) {
            const coord = coords[coordIndex];
            if (coord === undefined) {
                continue;
            }

            if (second - coord > -intersectionTolerance) {
                if (coordIndex < coords.length - 1) {
                    second = coords[coordIndex + 1] ?? second;
                }
                break;
            }
        }

        out[index] =
            orientation === "h"
                ? tableResizeEdge(tableResizeEdge(edge, "x0", first), "x1", second)
                : tableResizeEdge(tableResizeEdge(edge, "top", first), "bottom", second);
    }

    return out;
}

function tableFilterTablesByStructure(tables: TableBBox[][], minRows: number, minCols: number): TableBBox[][] {
    return tables.filter((table) => {
        if (table.length === 0) {
            return false;
        }

        const rows = tableCountDistinctCoords(
            table.map((cell) => cell.top),
            TABLE_POINT_EQUALITY_TOLERANCE
        );
        const cols = tableCountDistinctCoords(
            table.map((cell) => cell.x0),
            TABLE_POINT_EQUALITY_TOLERANCE
        );
        return rows >= minRows && cols >= minCols;
    });
}

function tableCountDistinctCoords(values: number[], tolerance: number): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    let count = 1;
    let last = sorted[0] ?? 0;
    for (const value of sorted.slice(1)) {
        if (!tableAlmostEqual(value, last, tolerance)) {
            count += 1;
            last = value;
        }
    }

    return count;
}

function tableMergeEdges(
    edges: TableEdge[],
    snapXTolerance: number,
    snapYTolerance: number,
    joinXTolerance: number,
    joinYTolerance: number
): TableEdge[] {
    let current = edges;
    if (snapXTolerance > 0 || snapYTolerance > 0) {
        current = tableSnapEdges(current, snapXTolerance, snapYTolerance);
    }

    const sorted = [...current].sort((a, b) => {
        if (a.orientation !== b.orientation) {
            return a.orientation.localeCompare(b.orientation);
        }
        const coordA = a.orientation === "h" ? a.top : a.x0;
        const coordB = b.orientation === "h" ? b.top : b.x0;
        return coordA - coordB;
    });

    const groups: TableEdge[][] = [];
    for (const edge of sorted) {
        const lastGroup = groups.at(-1);
        const lastEdge = lastGroup?.at(-1);
        if (!lastGroup || !lastEdge) {
            groups.push([edge]);
            continue;
        }

        const lastCoord = lastEdge.orientation === "h" ? lastEdge.top : lastEdge.x0;
        const edgeCoord = edge.orientation === "h" ? edge.top : edge.x0;
        if (
            lastEdge.orientation === edge.orientation &&
            tableAlmostEqual(lastCoord, edgeCoord, TABLE_POINT_EQUALITY_TOLERANCE)
        ) {
            lastGroup.push(edge);
        } else {
            groups.push([edge]);
        }
    }

    return groups.flatMap((group) => {
        const first = group[0];
        if (!first) {
            return [];
        }
        const tolerance = first.orientation === "h" ? joinXTolerance : joinYTolerance;
        return tableJoinEdgeGroup(group, first.orientation, tolerance);
    });
}

function tableSnapEdges(edges: TableEdge[], xTolerance: number, yTolerance: number): TableEdge[] {
    const vertical = tableSnapEdgesBy(
        edges.filter((edge) => edge.orientation === "v"),
        "x0",
        xTolerance
    );
    const horizontal = tableSnapEdgesBy(
        edges.filter((edge) => edge.orientation === "h"),
        "top",
        yTolerance
    );
    return [...vertical, ...horizontal];
}

function tableSnapEdgesBy(edges: TableEdge[], attr: "x0" | "top", tolerance: number): TableEdge[] {
    if (edges.length === 0 || tolerance <= 0) {
        return edges.map((edge) => ({ ...edge }));
    }

    const sorted = [...edges].sort((a, b) => tableEdgeProp(a, attr) - tableEdgeProp(b, attr));
    const clusters: TableEdge[][] = [];
    let currentCluster: TableEdge[] = [];
    let last = Number.NaN;

    for (const edge of sorted) {
        const value = tableEdgeProp(edge, attr);
        if (currentCluster.length === 0 || value <= last + tolerance) {
            currentCluster.push({ ...edge });
        } else {
            clusters.push(currentCluster);
            currentCluster = [{ ...edge }];
        }
        last = value;
    }
    if (currentCluster.length > 0) {
        clusters.push(currentCluster);
    }

    return clusters.flatMap((cluster) => {
        const avg = average(cluster.map((edge) => tableEdgeProp(edge, attr)));
        return cluster.map((edge) => {
            const delta = avg - tableEdgeProp(edge, attr);
            if (edge.orientation === "v") {
                edge.x0 += delta;
                edge.x1 += delta;
            } else {
                edge.top += delta;
                edge.bottom += delta;
            }
            return edge;
        });
    });
}

function tableJoinEdgeGroup(edges: TableEdge[], orientation: "h" | "v", tolerance: number): TableEdge[] {
    if (edges.length === 0) {
        return [];
    }

    const minProp = orientation === "v" ? "top" : "x0";
    const maxProp = orientation === "v" ? "bottom" : "x1";
    const sorted = [...edges].sort((a, b) => tableEdgeProp(a, minProp) - tableEdgeProp(b, minProp));
    const joined: TableEdge[] = [{ ...sorted[0]! }];

    for (const edge of sorted.slice(1)) {
        const last = joined[joined.length - 1]!;
        if (tableEdgeProp(edge, minProp) <= tableEdgeProp(last, maxProp) + tolerance) {
            if (tableEdgeProp(edge, maxProp) > tableEdgeProp(last, maxProp)) {
                joined[joined.length - 1] = tableResizeEdge(last, maxProp, tableEdgeProp(edge, maxProp));
            }
        } else {
            joined.push({ ...edge });
        }
    }

    return joined;
}

function tableWordsToEdgesH(words: TableWord[], wordThreshold: number): TableEdge[] {
    const clusters = tableClusterWords(words, (word) => word.top, 1).filter(
        (cluster) => cluster.length >= wordThreshold
    );
    if (clusters.length === 0) {
        return [];
    }

    const rects = clusters.map((cluster) => tableWordsToBBox(cluster));
    const minX0 = Math.min(...rects.map((rect) => rect.x0));
    const maxX1 = Math.max(...rects.map((rect) => rect.x1));
    return rects.flatMap((rect) => [
        {
            objectType: "line",
            orientation: "h" as const,
            x0: minX0,
            x1: maxX1,
            top: rect.top,
            bottom: rect.top,
            width: maxX1 - minX0,
            height: 0,
        },
        {
            objectType: "line",
            orientation: "h" as const,
            x0: minX0,
            x1: maxX1,
            top: rect.bottom,
            bottom: rect.bottom,
            width: maxX1 - minX0,
            height: 0,
        },
    ]);
}

function tableWordsToEdgesV(words: TableWord[], wordThreshold: number): TableEdge[] {
    const clusters = [
        ...tableClusterWords(words, (word) => word.x0, 1),
        ...tableClusterWords(words, (word) => word.x1, 1),
        ...tableClusterWords(words, (word) => (word.x0 + word.x1) / 2, 1),
    ]
        .filter((cluster) => cluster.length >= wordThreshold)
        .sort((a, b) => b.length - a.length);

    const condensed: TableBBox[] = [];
    for (const bbox of clusters.map((cluster) => tableWordsToBBox(cluster))) {
        if (!condensed.some((candidate) => tableBBoxOverlap(candidate, bbox) !== null)) {
            condensed.push(bbox);
        }
    }

    if (condensed.length === 0) {
        return [];
    }

    condensed.sort((a, b) => a.x0 - b.x0);
    const maxX1 = Math.max(...condensed.map((bbox) => bbox.x1));
    const minTop = Math.min(...condensed.map((bbox) => bbox.top));
    const maxBottom = Math.max(...condensed.map((bbox) => bbox.bottom));
    const edges = condensed.map((bbox) => ({
        objectType: "line",
        orientation: "v" as const,
        x0: bbox.x0,
        x1: bbox.x0,
        top: minTop,
        bottom: maxBottom,
        width: 0,
        height: maxBottom - minTop,
    }));
    edges.push({
        objectType: "line",
        orientation: "v",
        x0: maxX1,
        x1: maxX1,
        top: minTop,
        bottom: maxBottom,
        width: 0,
        height: maxBottom - minTop,
    });
    return edges;
}

function tableEdgesToIntersections(
    edges: TableEdge[],
    xTolerance: number,
    yTolerance: number
): Map<string, { point: TablePoint; edges: TableIntersectionEdges }> {
    const intersections = new Map<string, { point: TablePoint; edges: TableIntersectionEdges }>();
    const verticalEdges = tableFilterEdges(edges, "v", "", 0).sort((a, b) =>
        a.x0 === b.x0 ? a.top - b.top : a.x0 - b.x0
    );
    const horizontalEdges = tableFilterEdges(edges, "h", "", 0).sort((a, b) =>
        a.top === b.top ? a.x0 - b.x0 : a.top - b.top
    );

    for (const vertical of verticalEdges) {
        for (const horizontal of horizontalEdges) {
            if (
                vertical.top <= horizontal.top + yTolerance &&
                vertical.bottom >= horizontal.top - yTolerance &&
                vertical.x0 >= horizontal.x0 - xTolerance &&
                vertical.x0 <= horizontal.x1 + xTolerance
            ) {
                const point = { x: vertical.x0, y: horizontal.top };
                const key = tablePointKey(point);
                const entry = intersections.get(key) ?? { point, edges: { v: [], h: [] } };
                entry.edges.v.push(vertical);
                entry.edges.h.push(horizontal);
                intersections.set(key, entry);
            }
        }
    }

    return intersections;
}

function tableIntersectionsToCells(
    intersections: Map<string, { point: TablePoint; edges: TableIntersectionEdges }>
): TableBBox[] {
    const points = [...intersections.values()]
        .map((entry) => entry.point)
        .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

    const edgeConnects = (pointA: TablePoint, pointB: TablePoint): boolean => {
        const entryA = intersections.get(tablePointKey(pointA));
        const entryB = intersections.get(tablePointKey(pointB));
        if (!entryA || !entryB) {
            return false;
        }

        if (tableAlmostEqual(pointA.x, pointB.x, TABLE_POINT_EQUALITY_TOLERANCE)) {
            const setA = new Set(
                entryA.edges.v.map((edge) =>
                    tableBBoxKey({ x0: edge.x0, top: edge.top, x1: edge.x1, bottom: edge.bottom })
                )
            );
            return entryB.edges.v.some((edge) =>
                setA.has(tableBBoxKey({ x0: edge.x0, top: edge.top, x1: edge.x1, bottom: edge.bottom }))
            );
        }

        if (tableAlmostEqual(pointA.y, pointB.y, TABLE_POINT_EQUALITY_TOLERANCE)) {
            const setA = new Set(
                entryA.edges.h.map((edge) =>
                    tableBBoxKey({ x0: edge.x0, top: edge.top, x1: edge.x1, bottom: edge.bottom })
                )
            );
            return entryB.edges.h.some((edge) =>
                setA.has(tableBBoxKey({ x0: edge.x0, top: edge.top, x1: edge.x1, bottom: edge.bottom }))
            );
        }

        return false;
    };

    const cells: TableBBox[] = [];
    for (let index = 0; index < points.length; index += 1) {
        const point = points[index]!;
        const rest = points.slice(index + 1);
        const below = rest.filter((candidate) =>
            tableAlmostEqual(candidate.x, point.x, TABLE_POINT_EQUALITY_TOLERANCE)
        );
        const right = rest.filter((candidate) =>
            tableAlmostEqual(candidate.y, point.y, TABLE_POINT_EQUALITY_TOLERANCE)
        );

        let found: TableBBox | null = null;
        for (const belowPoint of below) {
            if (!edgeConnects(point, belowPoint)) {
                continue;
            }
            for (const rightPoint of right) {
                if (!edgeConnects(point, rightPoint)) {
                    continue;
                }
                const bottomRight = { x: rightPoint.x, y: belowPoint.y };
                if (
                    intersections.has(tablePointKey(bottomRight)) &&
                    edgeConnects(bottomRight, rightPoint) &&
                    edgeConnects(bottomRight, belowPoint)
                ) {
                    found = { x0: point.x, top: point.y, x1: bottomRight.x, bottom: bottomRight.y };
                    break;
                }
            }
            if (found) {
                break;
            }
        }

        if (found) {
            cells.push(found);
        }
    }

    return cells;
}

function tableCellsToTables(cells: TableBBox[]): TableBBox[][] {
    const remaining = [...cells];
    const tables: TableBBox[][] = [];
    let currentCells: TableBBox[] = [];
    let currentCorners = new Set<string>();

    const corners = (bbox: TableBBox): TablePoint[] => [
        { x: bbox.x0, y: bbox.top },
        { x: bbox.x0, y: bbox.bottom },
        { x: bbox.x1, y: bbox.top },
        { x: bbox.x1, y: bbox.bottom },
    ];

    while (remaining.length > 0) {
        const initialCount = currentCells.length;
        const nextRemaining: TableBBox[] = [];

        for (const cell of remaining) {
            const cellCorners = corners(cell);
            if (currentCells.length === 0) {
                cellCorners.forEach((corner) => currentCorners.add(tablePointKey(corner)));
                currentCells.push(cell);
                continue;
            }

            const sharedCorners = cellCorners.filter((corner) => currentCorners.has(tablePointKey(corner))).length;
            if (sharedCorners > 0) {
                cellCorners.forEach((corner) => currentCorners.add(tablePointKey(corner)));
                currentCells.push(cell);
            } else {
                nextRemaining.push(cell);
            }
        }

        if (currentCells.length === initialCount) {
            if (currentCells.length > 1) {
                tables.push([...currentCells]);
            }
            currentCells = [];
            currentCorners = new Set<string>();
        }

        remaining.splice(0, remaining.length, ...nextRemaining);
    }

    if (currentCells.length > 1) {
        tables.push([...currentCells]);
    }

    return tables.sort((a, b) => {
        const cornerA = tableMinCorner(a);
        const cornerB = tableMinCorner(b);
        return cornerA.top === cornerB.top ? cornerA.x0 - cornerB.x0 : cornerA.top - cornerB.top;
    });
}

function tableModelBBox(model: TableModelData): TableBBox {
    return model.cells.reduce((accumulator, cell) => ({
        x0: Math.min(accumulator.x0, cell.x0),
        top: Math.min(accumulator.top, cell.top),
        x1: Math.max(accumulator.x1, cell.x1),
        bottom: Math.max(accumulator.bottom, cell.bottom),
    }));
}

function tableModelToCells(model: TableModelData, pageHeight: number): TableCell[] {
    const rows = tableModelRows(model);
    const cells: TableCell[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex]!;
        for (let colIndex = 0; colIndex < row.cells.length; colIndex += 1) {
            const cell = row.cells[colIndex];
            if (!cell) {
                continue;
            }
            cells.push({
                bbox: tableBBoxToBoundingBox(cell, pageHeight),
                row: rowIndex,
                col: colIndex,
                text: "",
            });
        }
    }

    return cells;
}

function tableModelRows(model: TableModelData): TableCellGroup[] {
    return tableGetRowsOrCols(model, true);
}

function tableGetRowsOrCols(model: TableModelData, rows: boolean): TableCellGroup[] {
    const axis = rows ? 0 : 1;
    const antiaxis = rows ? 1 : 0;
    const sortedCells = [...model.cells].sort((a, b) => {
        const antiA = tableBBoxCoord(a, antiaxis);
        const antiB = tableBBoxCoord(b, antiaxis);
        return antiA === antiB ? tableBBoxCoord(a, axis) - tableBBoxCoord(b, axis) : antiA - antiB;
    });

    const axisValues = [...new Set(model.cells.map((cell) => tableBBoxCoord(cell, axis)))].sort((a, b) => a - b);
    const groups = new Map<number, TableBBox[]>();
    const order: number[] = [];
    for (const cell of sortedCells) {
        const key = tableBBoxCoord(cell, antiaxis);
        if (!groups.has(key)) {
            groups.set(key, []);
            order.push(key);
        }
        groups.get(key)!.push(cell);
    }

    return order.map((key) => {
        const groupCells = groups.get(key) ?? [];
        const byAxis = new Map(groupCells.map((cell) => [tableBBoxCoord(cell, axis), cell]));
        return tableMakeCellGroup(axisValues.map((value) => byAxis.get(value) ?? null));
    });
}

function tableExtractRows(model: TableModelData, textTolerance: number): Array<Array<string | null>> {
    const rows = tableModelRows(model);
    const inBBox = (char: TableChar, bbox: TableBBox) => {
        const verticalMid = (char.top + char.bottom) / 2;
        const horizontalMid = (char.x0 + char.x1) / 2;
        return (
            horizontalMid >= bbox.x0 && horizontalMid < bbox.x1 && verticalMid >= bbox.top && verticalMid < bbox.bottom
        );
    };

    return rows.map((row) => {
        const rowChars = model.page.chars.filter((char) => row.bbox && inBBox(char, row.bbox));
        return row.cells.map((cell) => {
            if (!cell) {
                return null;
            }
            return tableExtractCharsText(
                rowChars.filter((char) => inBBox(char, cell)),
                textTolerance
            );
        });
    });
}

function tableMakeCellGroup(cells: Array<TableBBox | null>): TableCellGroup {
    const valid = cells.filter((cell): cell is TableBBox => cell !== null);
    if (valid.length === 0) {
        return { cells, bbox: null };
    }

    const bbox = valid.reduce((accumulator, cell) => ({
        x0: Math.min(accumulator.x0, cell.x0),
        top: Math.min(accumulator.top, cell.top),
        x1: Math.max(accumulator.x1, cell.x1),
        bottom: Math.max(accumulator.bottom, cell.bottom),
    }));
    return { cells, bbox };
}

function tableExtractCharsText(chars: TableChar[], tolerance: number): string {
    if (chars.length === 0) {
        return "";
    }

    const lines = reconstructTextLinesFromChars(chars.map(tableCharToTextChar), tolerance);
    return lines
        .map((line) => normalizeTableCellText(reconstructLogicalLineText(line)))
        .filter(Boolean)
        .join("\n")
        .trim();
}

function reconstructTextLinesFromChars(chars: TextChar[], tolerance: number): TextChar[][] {
    const prepared = dedupeTextChars(chars);
    const horizontalChars = prepared.filter((char) => inferTextCharDirection(char) === "horizontal");
    const verticalChars = prepared.filter((char) => inferTextCharDirection(char) === "vertical");
    const horizontalLines = reconstructHorizontalTextLines(horizontalChars, tolerance);
    const verticalLines = buildVerticalTextLines(verticalChars).map((line) => getPreparedLineChars(line));

    return [...horizontalLines, ...verticalLines].sort((left, right) => {
        const bboxLeft = unionBoxes(left.map((char) => char.bbox));
        const bboxRight = unionBoxes(right.map((char) => char.bbox));
        if (!bboxLeft || !bboxRight) {
            return 0;
        }

        const topDelta = getTop(bboxRight) - getTop(bboxLeft);
        if (Math.abs(topDelta) > 1) {
            return topDelta;
        }

        return bboxLeft.x - bboxRight.x;
    });
}

function reconstructHorizontalTextLines(chars: TextChar[], tolerance: number): TextChar[][] {
    const ordered = dedupeTextChars(sortTextChars(chars));
    if (ordered.length === 0) {
        return [];
    }

    const lines: TextChar[][] = [[ordered[0]!]];
    for (const char of ordered.slice(1)) {
        const current = lines[lines.length - 1]!;
        const previous = current[current.length - 1]!;
        const baselineTolerance = Math.max(tolerance, Math.min(previous.fontSize, char.fontSize) * 0.5);
        const startsNewLine =
            Math.abs(char.baseline - previous.baseline) > baselineTolerance && !isScriptLikeTextChar(previous, char);

        if (startsNewLine) {
            lines.push([char]);
            continue;
        }

        current.push(char);
    }

    return lines;
}

function reconstructLogicalLineText(chars: TextChar[]): string {
    if (chars.length === 0) {
        return "";
    }

    const verticalCount = chars.filter((char) => inferTextCharDirection(char) === "vertical").length;
    if (verticalCount >= Math.ceil(chars.length * 0.6)) {
        return reconstructVerticalTextFromChars(chars);
    }

    return cleanupExtractedTextSpacing(reconstructTextFromChars(chars));
}

function tableCharToTextChar(char: TableChar): TextChar {
    return {
        char: char.text,
        bbox: {
            x: char.x0,
            y: char.top,
            width: char.x1 - char.x0,
            height: char.bottom - char.top,
        },
        fontSize: char.fontSize,
        fontName: char.fontName,
        baseline: char.baseline,
        sequenceIndex: char.sequenceIndex,
    };
}

function tableClusterWords(words: TableWord[], key: (word: TableWord) => number, tolerance: number): TableWord[][] {
    if (words.length === 0) {
        return [];
    }

    const sorted = [...words].sort((a, b) => key(a) - key(b));
    const clusters: TableWord[][] = [[sorted[0]!]];
    let last = key(sorted[0]!);

    for (const word of sorted.slice(1)) {
        const value = key(word);
        const current = clusters[clusters.length - 1]!;
        if (
            (tolerance === 0 && tableAlmostEqual(value, last, TABLE_POINT_EQUALITY_TOLERANCE)) ||
            (tolerance !== 0 && value <= last + tolerance)
        ) {
            current.push(word);
        } else {
            clusters.push([word]);
        }
        last = value;
    }

    return clusters;
}

function tableWordsToBBox(words: TableWord[]): TableBBox {
    return words.reduce(
        (accumulator, word) => ({
            x0: Math.min(accumulator.x0, word.x0),
            top: Math.min(accumulator.top, word.top),
            x1: Math.max(accumulator.x1, word.x1),
            bottom: Math.max(accumulator.bottom, word.bottom),
        }),
        {
            x0: words[0]!.x0,
            top: words[0]!.top,
            x1: words[0]!.x1,
            bottom: words[0]!.bottom,
        }
    );
}

function tableBBoxOverlap(a: TableBBox, b: TableBBox): TableBBox | null {
    const left = Math.max(a.x0, b.x0);
    const right = Math.min(a.x1, b.x1);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right - left >= 0 && bottom - top >= 0 && right + bottom - left - top > 0) {
        return { x0: left, top, x1: right, bottom };
    }
    return null;
}

function tableFilterEdges(
    edges: TableEdge[],
    orientation: "v" | "h" | "",
    edgeType: string,
    minLength: number
): TableEdge[] {
    return edges.filter((edge) => {
        if (orientation && edge.orientation !== orientation) {
            return false;
        }
        if (edgeType && edge.objectType !== edgeType) {
            return false;
        }
        const dimension = edge.orientation === "v" ? edge.height : edge.width;
        return dimension >= minLength;
    });
}

function tableResizeEdge(edge: TableEdge, key: "x0" | "x1" | "top" | "bottom", value: number): TableEdge {
    const updated = { ...edge, [key]: value };
    updated.width = updated.x1 - updated.x0;
    updated.height = updated.bottom - updated.top;
    return updated;
}

function tableEdgeProp(edge: TableEdge, attr: "x0" | "x1" | "top" | "bottom"): number {
    return edge[attr];
}

function tableBBoxCoord(bbox: TableBBox, axis: number): number {
    return axis === 0 ? bbox.x0 : bbox.top;
}

function tableMinCorner(cells: TableBBox[]): { top: number; x0: number } {
    return cells.reduce(
        (accumulator, cell) => ({
            top: Math.min(accumulator.top, cell.top),
            x0: Math.min(accumulator.x0, cell.x0),
        }),
        { top: cells[0]!.top, x0: cells[0]!.x0 }
    );
}

function tableBBoxKey(bbox: TableBBox): string {
    return `${bbox.x0.toFixed(6)}|${bbox.top.toFixed(6)}|${bbox.x1.toFixed(6)}|${bbox.bottom.toFixed(6)}`;
}

function tablePointKey(point: TablePoint): string {
    return `${point.x.toFixed(6)}|${point.y.toFixed(6)}`;
}

function tableAlmostEqual(a: number, b: number, epsilon: number): boolean {
    return Math.abs(a - b) <= epsilon;
}

function tableRowsToMarkdown(rows: Array<Array<string | null>>): string | null {
    const trimmed = rows
        .map((row) => row.map((cell) => (cell ?? "").trim()))
        .filter((row) => row.some((cell) => cell.length > 0));
    if (trimmed.length < 2) {
        return null;
    }

    const columnCount = Math.max(...trimmed.map((row) => row.length));
    if (columnCount < 2 || columnCount > TABLE_MAX_COLS) {
        return null;
    }

    const normalized = trimmed.map((row) =>
        Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? ""))
    );
    const header = normalized[0]!;
    if (header.filter(Boolean).length < Math.min(2, columnCount)) {
        return null;
    }

    const separator = Array.from({ length: columnCount }, () => "---");
    return [
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
}

function tableIsLikelyTabular(rows: Array<Array<string | null>>): boolean {
    if (rows.length < 2) {
        return false;
    }

    const columnCount = Math.max(...rows.map((row) => row.length));
    if (columnCount < 2 || columnCount > TABLE_MAX_COLS) {
        return false;
    }

    const totalCells = rows.length * columnCount;
    let nonEmpty = 0;
    let totalChars = 0;
    let maxChars = 0;

    for (const row of rows) {
        for (let column = 0; column < columnCount; column += 1) {
            const text = normalizeWhitespace(row[column] ?? "");
            if (!text) {
                continue;
            }
            nonEmpty += 1;
            const length = [...text].length;
            totalChars += length;
            maxChars = Math.max(maxChars, length);
        }
    }

    if (nonEmpty < 2) {
        return false;
    }
    if (nonEmpty / totalCells < 0.2) {
        return false;
    }
    if (nonEmpty <= 2 && totalChars > 0 && maxChars >= totalChars * 0.85) {
        return false;
    }

    return true;
}

function tablePassesTextOnlyHeuristics(rows: Array<Array<string | null>>): boolean {
    if (rows.length < 2) {
        return false;
    }

    const colCount = Math.max(...rows.map((row) => row.length));
    const flattened = rows.flatMap((row) => row.map((cell) => normalizeWhitespace(cell ?? "")).filter(Boolean));
    if (flattened.length < Math.max(4, colCount + 1)) {
        return false;
    }

    const longCells = flattened.filter((cell) => cell.length > 60).length;
    if (longCells > Math.ceil(flattened.length * 0.35)) {
        return false;
    }

    if (tableHasLeaderPatterns(rows, 2)) {
        return false;
    }

    if (tableCountStableColumns(rows) < Math.min(2, colCount)) {
        return false;
    }

    if (tableCountDenseDataRows(rows) < Math.max(1, Math.ceil((rows.length - 1) * 0.5))) {
        return false;
    }

    if (tableLooksLikeReferenceList(rows)) {
        return false;
    }

    return true;
}

function normalizeExtractedTableRows(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    let normalized = rows.map((row) => row.map((cell) => normalizeTableCellText(cell ?? "") || null));
    normalized = normalized.filter((row) => row.some(Boolean));
    if (normalized.length === 0) {
        return normalized;
    }

    normalized = padTableRows(normalized);
    normalized = removeEmptyTableColumns(normalized);

    let changed = true;
    while (changed) {
        changed = false;
        const mergeIndex = findMergeableColumnIndex(normalized);
        if (mergeIndex !== null) {
            normalized = mergeAdjacentTableColumns(normalized, mergeIndex);
            normalized = removeEmptyTableColumns(normalized);
            changed = true;
        }
    }

    normalized = mergeWrappedTableRows(normalized);
    normalized = normalized.filter((row) => row.some(Boolean));
    normalized = removeEmptyTableColumns(padTableRows(normalized));

    normalized = mergeHeaderRows(normalized);

    if (normalized.length >= 2) {
        const header = normalized[0] ?? [];
        const second = normalized[1] ?? [];
        const secondNonEmpty = second.flatMap((cell, index) => (cell ? [{ cell, index }] : []));
        if (secondNonEmpty.length === 1) {
            const only = secondNonEmpty[0];
            if (only) {
                const current = header[only.index] ?? null;
                header[only.index] = normalizeWhitespace([current, only.cell].filter(Boolean).join(" ")) || current;
                normalized.splice(1, 1);
            }
        }
    }

    return normalized;
}

function normalizeTableCellText(value: string): string {
    return normalizeWhitespace(value)
        .replace(/([A-Za-zÄÖÜäöüß])-\s+(?=[a-zäöüß])/g, "$1")
        .trim();
}

function detectWhitespaceSeparatedTables(lines: TextLine[], excludedRegions: BoundingBox[]): TableBlock[] {
    const candidates = lines
        .filter((line) => inferLineDirection(line) === "horizontal")
        .map((line, lineIndex) => segmentLine(line, lineIndex))
        .filter((line): line is SegmentedLine => line !== null)
        .filter((line) => !intersectsAny(line.bbox, excludedRegions, 0.2));

    const groups: SegmentedLine[][] = [];
    for (const candidate of candidates) {
        const current = groups.at(-1);
        const previous = current?.at(-1);
        if (!current || !previous || !canJoinSegmentedLines(previous, candidate, current)) {
            groups.push([candidate]);
            continue;
        }

        current.push(candidate);
    }

    const tables: TableBlock[] = [];
    for (const group of groups) {
        const table = segmentedLinesToTable(group);
        if (table) {
            tables.push(table);
        }
    }

    return tables;
}

function segmentLine(line: TextLine, lineIndex: number): SegmentedLine | null {
    const chars = getPreparedLineChars(line).filter((char) => char.bbox.width > 0 || char.char.length > 0);
    if (chars.length === 0) {
        return null;
    }

    const avgCharWidth =
        average(
            chars.filter((char) => getExpandedCharText(char.char).trim().length > 0).map((char) => char.bbox.width)
        ) || 4;
    const medianFontSize = median(chars.map((char) => char.fontSize)) || 12;
    const gapThreshold = Math.max(TEXT_SEGMENT_MIN_GAP, avgCharWidth * TEXT_SEGMENT_GAP_RATIO, medianFontSize * 1.5);
    const segments: LineSegmentBlock[] = [];
    let current: TextChar[] = [];

    for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index]!;
        const next = chars[index + 1];
        const previous = current[current.length - 1];
        const gap = previous ? char.bbox.x - (previous.bbox.x + previous.bbox.width) : 0;
        const isWideWhitespace = char.char.trim().length === 0 && char.bbox.width >= gapThreshold;
        const isDoubleWhitespace = char.char.trim().length === 0 && next?.char.trim().length === 0;
        const shouldBreakForGap =
            previous !== undefined && gap > Math.max(gapThreshold, getAdaptiveTextXTolerance(previous, char) * 3.5);
        if ((shouldBreakForGap || isWideWhitespace || isDoubleWhitespace) && current.length > 0) {
            const segment = textCharsToSegment(current);
            if (segment) {
                segments.push(segment);
            }
            current = [];
        }

        if (char.char.trim().length === 0) {
            if (!isWideWhitespace && !isDoubleWhitespace && current.length > 0) {
                current.push(char);
            }
            continue;
        }

        current.push(char);
    }

    const finalSegment = textCharsToSegment(current);
    if (finalSegment) {
        segments.push(finalSegment);
    }

    if (segments.length < 2) {
        return null;
    }

    return { lineIndex, bbox: line.bbox, segments };
}

function textCharsToSegment(chars: TextChar[]): LineSegmentBlock | null {
    if (chars.length === 0) {
        return null;
    }

    const bbox = unionBoxes(chars.map((char) => char.bbox));
    const text = normalizeTableCellText(reconstructTextFromChars(chars));
    if (!bbox || !text) {
        return null;
    }

    return { text, bbox };
}

function reconstructTextFromChars(chars: TextChar[]): string {
    const ordered = dedupeTextChars(sortTextChars(chars));
    const output: TextChar[] = [];
    const parts: string[] = [];

    for (let index = 0; index < ordered.length; index += 1) {
        const char = ordered[index]!;
        const text = getExpandedCharText(char.char);
        if (text.trim().length === 0) {
            const previous = output[output.length - 1];
            const nextVisible = ordered
                .slice(index + 1)
                .find((candidate) => getExpandedCharText(candidate.char).trim().length > 0);
            const isSyntheticSpace = typeof char.sequenceIndex === "number" && !Number.isInteger(char.sequenceIndex);
            const shouldIgnoreSyntheticSpace =
                isSyntheticSpace &&
                previous !== undefined &&
                nextVisible !== undefined &&
                !textCharBeginsNewWord(previous, nextVisible);
            if (!shouldIgnoreSyntheticSpace && parts.length > 0 && parts[parts.length - 1] !== " ") {
                parts.push(" ");
            }
            continue;
        }

        const previous = output[output.length - 1];
        if (!previous) {
            output.push(char);
            parts.push(text);
            continue;
        }

        const previousEnd = previous.bbox.x + previous.bbox.width;
        const gap = char.bbox.x - previousEnd;
        const heavyOverlap = char.bbox.x <= previous.bbox.x + Math.min(previous.bbox.width, char.bbox.width) * 0.6;

        if (heavyOverlap) {
            if (isLikelyDuplicateTextChar(previous, char)) {
                continue;
            }

            if (isScriptLikeTextChar(previous, char)) {
                output.push(char);
                parts.push(text);
                continue;
            }

            if (shouldReplaceOverlappingChar(previous, char)) {
                output[output.length - 1] = char;
                parts[parts.length - 1] = text;
                continue;
            }
        }

        if (shouldInsertSpaceBetweenChars(previous, char, gap)) {
            parts.push(" ");
        }

        output.push(char);
        parts.push(text);
    }

    return parts.join("");
}

function shouldReplaceOverlappingChar(previous: TextChar, current: TextChar): boolean {
    const previousChar = previous.char;
    const currentChar = current.char;

    if (/^[,.;:]$/.test(previousChar) && /[A-Za-z0-9]/.test(currentChar)) {
        return true;
    }

    if (previous.bbox.width >= current.bbox.width * 1.15 && /[A-Z]/.test(previousChar) && /[a-z]/.test(currentChar)) {
        return true;
    }

    if (
        previous.bbox.width >= current.bbox.width * 1.15 &&
        /[A-Za-z]/.test(previousChar) &&
        /[A-Za-z]/.test(currentChar)
    ) {
        return true;
    }

    return false;
}

function canJoinSegmentedLines(previous: SegmentedLine, candidate: SegmentedLine, group: SegmentedLine[]): boolean {
    const verticalGap = previous.bbox.y - getTop(candidate.bbox);
    if (verticalGap > Math.max(previous.bbox.height, candidate.bbox.height) * 2.2) {
        return false;
    }

    const anchors = [
        ...new Set(
            group
                .flatMap((line) => line.segments.map((segment) => segment.bbox.x))
                .map((value) => Math.round(value / 12) * 12)
        ),
    ];
    const candidateMatches = candidate.segments.filter((segment) =>
        anchors.some((anchor) => Math.abs(anchor - segment.bbox.x) <= 18)
    ).length;
    return candidateMatches >= Math.min(2, candidate.segments.length);
}

function segmentedLinesToTable(group: SegmentedLine[]): TableBlock | null {
    if (group.length < 2) {
        return null;
    }

    const columnAnchors = clusterNumericPositions(
        group.flatMap((line) => line.segments.map((segment) => segment.bbox.x)),
        18
    );
    if (columnAnchors.length < 2 || columnAnchors.length > TABLE_MAX_COLS) {
        return null;
    }

    const rows = group.map((line) => {
        const row = Array.from({ length: columnAnchors.length }, () => null as string | null);
        for (const segment of line.segments) {
            const index = nearestColumnIndex(segment.bbox.x, columnAnchors);
            if (index === null) {
                continue;
            }
            const current = row[index] ?? null;
            row[index] = normalizeTableCellText(joinUniqueTableParts(current ?? "", segment.text)) || current;
        }
        return row;
    });

    const normalizedRows = normalizeExtractedTableRows(rows);
    if (!tableIsLikelyTabular(normalizedRows) || !tablePassesWhitespaceTableHeuristics(normalizedRows)) {
        return null;
    }

    const markdown = tableRowsToMarkdown(normalizedRows);
    if (!markdown) {
        return null;
    }

    const bbox = unionBoxes(group.map((line) => line.bbox));
    if (!bbox) {
        return null;
    }

    const rowCount = normalizedRows.length;
    const colCount = Math.max(...normalizedRows.map((row) => row.length));
    const cells: TableCell[] = normalizedRows.flatMap((row, rowIndex) =>
        row.map((cell, colIndex) => ({
            bbox,
            row: rowIndex,
            col: colIndex,
            text: cell ?? "",
        }))
    );

    return { bbox, markdown, cells, rowCount, colCount };
}

function clusterNumericPositions(values: number[], tolerance: number): number[] {
    if (values.length === 0) {
        return [];
    }

    const sorted = [...values].sort((a, b) => a - b);
    const clusters: number[][] = [[sorted[0]!]];
    for (const value of sorted.slice(1)) {
        const current = clusters[clusters.length - 1]!;
        const anchor = average(current);
        if (Math.abs(anchor - value) <= tolerance) {
            current.push(value);
        } else {
            clusters.push([value]);
        }
    }

    return clusters.map((cluster) => average(cluster));
}

function nearestColumnIndex(x: number, anchors: number[]): number | null {
    let bestIndex: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < anchors.length; index += 1) {
        const distance = Math.abs(anchors[index]! - x);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }

    return bestDistance <= 24 ? bestIndex : null;
}

function tablePassesWhitespaceTableHeuristics(rows: Array<Array<string | null>>): boolean {
    if (rows.length < 3) {
        return false;
    }

    const colCount = Math.max(...rows.map((row) => row.length));
    if (colCount < 2 || colCount > TABLE_MAX_COLS) {
        return false;
    }

    if (tableHasLeaderPatterns(rows, 3)) {
        return false;
    }

    if (tableLooksLikeReferenceList(rows)) {
        return false;
    }

    if (tableCountStableColumns(rows) < Math.min(2, colCount)) {
        return false;
    }

    const dataRows = rows.slice(1);
    const numericRows = dataRows.filter((row) => row.some((cell) => /\d/.test(cell ?? ""))).length;
    if (numericRows === 0 && colCount > 2) {
        return false;
    }

    const denseRows = dataRows.filter(
        (row) => row.filter(Boolean).length >= Math.max(3, Math.floor(colCount * 0.8))
    ).length;
    const longCells = rows
        .flatMap((row) => row)
        .filter((cell): cell is string => Boolean(cell))
        .filter((cell) => cell.length > 50).length;
    if (denseRows > 3 && longCells > 2) {
        return false;
    }

    const filledCells = rows.flatMap((row) => row).filter((cell): cell is string => Boolean(cell));
    const proseLikeCells = filledCells.filter((cell) => cell.length >= 24 && /\s/.test(cell)).length;
    if (colCount === 2 && numericRows === 0 && proseLikeCells >= Math.ceil(filledCells.length * 0.7)) {
        return false;
    }

    return true;
}

function tableHasLeaderPatterns(rows: Array<Array<string | null>>, sampleRowCount: number): boolean {
    return rows
        .slice(0, sampleRowCount)
        .some((row) => row.some((cell) => /(?:\.{3,}|_{3,}|\s\.\s\.\s\.)/.test(cell ?? "")));
}

function tableCountStableColumns(rows: Array<Array<string | null>>): number {
    const colCount = Math.max(0, ...rows.map((row) => row.length));
    let stable = 0;

    for (let columnIndex = 0; columnIndex < colCount; columnIndex += 1) {
        const values = rows.map((row) => normalizeWhitespace(row[columnIndex] ?? "")).filter(Boolean);

        if (values.length < 2) {
            continue;
        }

        const signatures = values.map(tableCellSignature);
        const counts = new Map<string, number>();
        for (const signature of signatures) {
            counts.set(signature, (counts.get(signature) ?? 0) + 1);
        }

        const dominant = Math.max(...counts.values());
        if (dominant >= Math.max(2, Math.ceil(values.length * 0.6))) {
            stable += 1;
        }
    }

    return stable;
}

function tableCellSignature(value: string): string {
    if (/^[\d.,]+%?$/.test(value)) {
        return "numeric";
    }
    if (/^[[\]()\d.,%\-/:]+$/.test(value)) {
        return "symbolic";
    }
    if (value.length <= 24) {
        return "short-text";
    }
    return "long-text";
}

function tableCountDenseDataRows(rows: Array<Array<string | null>>): number {
    const colCount = Math.max(0, ...rows.map((row) => row.length));
    const minimumFilled = Math.max(2, Math.ceil(colCount * 0.6));
    return rows.slice(1).filter((row) => row.filter(Boolean).length >= minimumFilled).length;
}

function tableLooksLikeReferenceList(rows: Array<Array<string | null>>): boolean {
    const colCount = Math.max(0, ...rows.map((row) => row.length));
    if (colCount < 2 || colCount > 4 || rows.length < 4) {
        return false;
    }

    const dataRows = rows.slice(1);
    const citationRows = dataRows.filter((row) => isReferenceMarker(normalizeWhitespace(row[0] ?? ""))).length;
    if (citationRows < Math.ceil(dataRows.length * 0.6)) {
        return false;
    }

    const descriptiveRows = dataRows.filter((row) => {
        const trailing = normalizeWhitespace(row.slice(1).filter(Boolean).join(" "));
        return trailing.length > 24;
    }).length;

    return descriptiveRows >= Math.ceil(dataRows.length * 0.6);
}

function isReferenceMarker(value: string): boolean {
    return /^[[(]?\d+[\]).]?$/.test(value);
}

function padTableRows(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    const width = Math.max(0, ...rows.map((row) => row.length));
    return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? null));
}

function mergeHeaderRows(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    if (rows.length < 3) {
        return rows;
    }

    let headerCount = 1;
    for (let index = 1; index < Math.min(3, rows.length); index += 1) {
        const row = rows[index] ?? [];
        const values = row.map((cell) => normalizeWhitespace(cell ?? "")).filter(Boolean);
        const numericValues = values.filter((value) => /\d/.test(value) && !/^\[[^\]]+\]$/.test(value)).length;
        const unitValues = values.filter((value) => /^\[[^\]]+\]$/.test(value)).length;
        const maxValueLength = Math.max(0, ...values.map((value) => value.length));
        if (numericValues > 1) {
            break;
        }
        if (values.length > 0 && maxValueLength <= 24 && (unitValues > 0 || values.length <= row.length)) {
            headerCount = index + 1;
            continue;
        }
        break;
    }

    if (headerCount === 1) {
        return rows;
    }

    const mergedHeader = Array.from({ length: Math.max(...rows.map((row) => row.length)) }, (_, columnIndex) => {
        return (
            normalizeTableCellText(
                rows
                    .slice(0, headerCount)
                    .map((row) => row[columnIndex] ?? "")
                    .filter(Boolean)
                    .join(" ")
            ) || null
        );
    });

    return [mergedHeader, ...rows.slice(headerCount)];
}

function removeEmptyTableColumns(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    if (rows.length === 0) {
        return rows;
    }

    const width = Math.max(...rows.map((row) => row.length));
    const keep = Array.from({ length: width }, (_, index) => rows.some((row) => Boolean(row[index])));
    return rows.map((row) => row.filter((_, index) => keep[index]));
}

function findMergeableColumnIndex(rows: Array<Array<string | null>>): number | null {
    if (rows.length === 0) {
        return null;
    }

    const width = Math.max(...rows.map((row) => row.length));
    for (let index = 0; index < width - 1; index += 1) {
        let leftCount = 0;
        let rightCount = 0;
        let overlapCount = 0;

        for (const row of rows) {
            const left = normalizeWhitespace(row[index] ?? "");
            const right = normalizeWhitespace(row[index + 1] ?? "");
            if (left) {
                leftCount += 1;
            }
            if (right) {
                rightCount += 1;
            }
            if (left && right) {
                overlapCount += 1;
            }
        }

        const sparsePair = Math.min(leftCount, rightCount) <= 2;
        if (sparsePair && overlapCount <= 1) {
            return index;
        }
    }

    return null;
}

function mergeAdjacentTableColumns(rows: Array<Array<string | null>>, index: number): Array<Array<string | null>> {
    return rows.map((row) => {
        const left = normalizeWhitespace(row[index] ?? "");
        const right = normalizeWhitespace(row[index + 1] ?? "");
        const merged = normalizeWhitespace(joinUniqueTableParts(left, right));
        return row.flatMap((cell, cellIndex) => {
            if (cellIndex === index) {
                return [merged || null];
            }
            if (cellIndex === index + 1) {
                return [];
            }
            return [cell ?? null];
        });
    });
}

function joinUniqueTableParts(left: string, right: string): string {
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }
    if (left === right) {
        return left;
    }
    if (left.includes(right)) {
        return left;
    }
    if (right.includes(left)) {
        return right;
    }
    return `${left} ${right}`;
}

function mergeWrappedTableRows(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    const merged = rows.map((row) => [...row]);

    for (let index = 0; index < merged.length; index += 1) {
        const row = merged[index];
        if (!row) {
            continue;
        }

        const nonEmpty = row.flatMap((cell, cellIndex) => (cell ? [{ cell, cellIndex }] : []));
        if (nonEmpty.length !== 1 || nonEmpty[0]?.cellIndex !== 0) {
            continue;
        }

        const text = nonEmpty[0].cell;
        if (!text) {
            continue;
        }

        const previous = merged[index - 1];
        const next = merged[index + 1];
        const previousHasValue = previous ? previous.slice(1).some(Boolean) : false;
        const nextHasValue = next ? next.slice(1).some(Boolean) : false;

        if (text.endsWith("-") && next?.[0]) {
            next[0] = normalizeWhitespace(`${text.slice(0, -1)}${next[0]}`) || next[0];
            merged[index] = row.map(() => null);
            continue;
        }

        if ((/^[a-zäöü]/.test(text) || /^und\b/i.test(text)) && previous?.[0]) {
            previous[0] = normalizeWhitespace(`${previous[0]} ${text}`) || previous[0];
            merged[index] = row.map(() => null);
            continue;
        }

        if (nextHasValue && next?.[0]) {
            next[0] = normalizeWhitespace(`${text} ${next[0]}`) || next[0];
            merged[index] = row.map(() => null);
            continue;
        }

        if (previousHasValue && previous?.[0]) {
            previous[0] = normalizeWhitespace(`${previous[0]} ${text}`) || previous[0];
            merged[index] = row.map(() => null);
        }
    }

    return merged;
}

function tableBBoxToBoundingBox(bbox: TableBBox, pageHeight: number): BoundingBox {
    return {
        x: bbox.x0,
        y: pageHeight - bbox.bottom,
        width: bbox.x1 - bbox.x0,
        height: bbox.bottom - bbox.top,
    };
}
