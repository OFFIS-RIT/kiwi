import type { LanguageModelV3 } from "@ai-sdk/provider";

export type PDFOCRImage = {
    id: string;
    type: string;
    content: Uint8Array;
};

export type PDFTableMode = "lines" | "lines_strict";

export type PDFParserOptions = {
    tableMode?: PDFTableMode;
};

export type PDFPageRasterizer = (content: Uint8Array) => Promise<Uint8Array[]>;
export type PDFSelectedPageRasterizer = (
    content: Uint8Array,
    pages: Array<Pick<PDFPageLike, "index" | "width" | "height">>
) => Promise<Map<number, Uint8Array>>;
export type PDFPageTranscriber = (image: Uint8Array, model: LanguageModelV3) => Promise<string>;

export type FullOCRDeps = {
    rasterizePages?: PDFPageRasterizer;
    rasterizeSelectedPages?: PDFSelectedPageRasterizer;
    transcribePage?: PDFPageTranscriber;
};

export type BoundingBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type TextDirection = "horizontal" | "vertical";

export type TextChar = {
    char: string;
    bbox: BoundingBox;
    fontSize: number;
    fontName: string;
    baseline: number;
    sequenceIndex?: number;
};

export type TextSpan = {
    text: string;
    bbox: BoundingBox;
    chars: TextChar[];
    fontSize: number;
    fontName: string;
};

export type TextLine = {
    text: string;
    bbox: BoundingBox;
    spans: TextSpan[];
    baseline: number;
    direction?: TextDirection;
};

export type PageText = {
    pageIndex: number;
    width: number;
    height: number;
    lines: TextLine[];
    text: string;
};

export type Matrix2D = {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
};

export type PDFNameLike = {
    type: "name";
    value: string;
};

export type PDFNumberLike = {
    type: "number";
    value: number;
};

export type PDFRefLike = {
    type: "ref";
};

export type PDFArrayLike = {
    type: "array";
    length: number;
    at: (index: number, resolver?: (ref: PDFRefLike) => unknown) => unknown;
    [Symbol.iterator](): Iterator<unknown>;
};

export type PDFDictLike = {
    type: "dict" | "stream";
    get: (key: string | PDFNameLike, resolver?: (ref: PDFRefLike) => unknown) => unknown;
    getArray: (key: string, resolver?: (ref: PDFRefLike) => unknown) => PDFArrayLike | undefined;
    getDict: (key: string, resolver?: (ref: PDFRefLike) => unknown) => PDFDictLike | undefined;
    getName: (key: string, resolver?: (ref: PDFRefLike) => unknown) => PDFNameLike | undefined;
    getNumber: (key: string, resolver?: (ref: PDFRefLike) => unknown) => PDFNumberLike | undefined;
    [Symbol.iterator](): Iterator<[PDFNameLike, unknown]>;
};

export type PDFStreamLike = PDFDictLike & {
    type: "stream";
    data: Uint8Array;
    getDecodedData: () => Uint8Array;
};

export type PDFImageAsset = {
    type: string;
    content: Uint8Array;
};

export type PDFPageLike = {
    index: number;
    width: number;
    height: number;
    dict: PDFDictLike;
    getResources: () => PDFDictLike;
    extractText: () => PageText;
};

export type PDFDocumentLike = {
    getPages: () => PDFPageLike[];
    getObject: (ref: PDFRefLike) => unknown;
};

export type LineSegment = {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    width: number;
    source: Edge["source"];
};

export type Edge = {
    orientation: "vertical" | "horizontal";
    position: number;
    start: number;
    end: number;
    source: "line" | "rect" | "curve" | "text";
};

export type Word = {
    text: string;
    bbox: BoundingBox;
    lineIndex: number;
};

export type ImageOccurrence = {
    id: string;
    type: string;
    content: Uint8Array;
    bbox: BoundingBox;
    pageIndex: number;
};

export type PageContentAnalysis = {
    images: ImageOccurrence[];
    explicitEdges: Edge[];
    actualTextSpans: ActualTextSpan[];
};

export type PreparedPage = {
    page: PDFPageLike;
    pageText: PageText;
    content: PageContentAnalysis;
    ocrFallback: boolean;
};

export type PathState = {
    currentPoint: { x: number; y: number } | null;
    subpathStartPoint: { x: number; y: number } | null;
    subpaths: LineSegment[];
    rectangles: BoundingBox[];
};

export type GraphicsState = {
    ctm: Matrix2D;
    lineWidth: number;
    path: PathState;
};

export type ActualTextSpan = {
    startSequenceIndex: number;
    endSequenceIndex: number;
    text: string;
    tag: string | null;
    mcid: number | null;
};

export type MarkedContentEntry = {
    tag: string | null;
    mcid: number | null;
    actualText: string | null;
    startSequenceIndex: number | null;
    endSequenceIndex: number | null;
};

export type MarkedContentState = {
    stack: MarkedContentEntry[];
    textSequenceIndex: number;
};

export interface OperandDictionary {
    [key: string]: Operand;
}

export type TableCell = {
    bbox: BoundingBox;
    row: number;
    col: number;
    text: string;
};

export type TableBlock = {
    bbox: BoundingBox;
    markdown: string;
    cells: TableCell[];
    rowCount: number;
    colCount: number;
};

export type TableSettings = {
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

export type TableBBox = {
    x0: number;
    top: number;
    x1: number;
    bottom: number;
};

export type TablePoint = {
    x: number;
    y: number;
};

export type TableIntersectionEdges = {
    v: TableEdge[];
    h: TableEdge[];
};

export type TableEdge = {
    objectType: string;
    orientation: "v" | "h";
    x0: number;
    x1: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
};

export type TableWord = {
    text: string;
    x0: number;
    x1: number;
    top: number;
    bottom: number;
    lineIndex: number;
};

export type TableChar = {
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

export type TablePage = {
    bbox: TableBBox;
    words: TableWord[];
    chars: TableChar[];
    edges: TableEdge[];
};

export type TableModelData = {
    page: TablePage;
    cells: TableBBox[];
};

export type TableCellGroup = {
    cells: Array<TableBBox | null>;
    bbox: TableBBox | null;
};

export type RenderBlock = {
    kind: "text" | "table" | "image";
    top: number;
    left: number;
    text: string;
    bbox: BoundingBox;
};

export type PositionedRegion<T> = {
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

export type LineSegmentBlock = {
    text: string;
    bbox: BoundingBox;
};

export type SegmentedLine = {
    lineIndex: number;
    bbox: BoundingBox;
    segments: LineSegmentBlock[];
};

export type Operand = number | string | Uint8Array | Operand[] | OperandDictionary | null;
