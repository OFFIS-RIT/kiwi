import type {
    ActualTextSpan,
    BoundingBox,
    Edge,
    GraphicsState,
    ImageOccurrence,
    MarkedContentEntry,
    MarkedContentState,
    Matrix2D,
    Operand,
    OperandDictionary,
    PageContentAnalysis,
    PDFDictLike,
    PDFDocumentLike,
    PDFPageLike,
    PDFRefLike,
    PDFStreamLike,
    PathState,
} from "./types";
import { DEFAULT_LINE_WIDTH, EDGE_MIN_LENGTH, EDGE_SNAP_TOLERANCE, IDENTITY_MATRIX } from "./constants";
import { extractPDFImageAsset } from "./image";
import {
    average,
    boundingBoxFromPoints,
    cloneGraphicsState,
    cloneMatrix,
    createEmptyPathState,
    getMatrixFromArray,
    isPDFArray,
    isPDFDict,
    isPDFName,
    isPDFNumber,
    isPDFRef,
    isPDFStream,
    isPDFStringLike,
    mergeEdges,
    multiplyMatrices,
    safelyDecodeStream,
    squashWhitespace,
    transformPoint,
} from "./geometry";

export function analyzePageContent(
    pdf: PDFDocumentLike,
    page: PDFPageLike,
    nextImageId: () => string
): PageContentAnalysis {
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

export function getContentStreams(object: unknown, resolver?: (ref: PDFRefLike) => unknown): PDFStreamLike[] {
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

export function scanContentStream(options: {
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
                    state.path.subpathStartPoint = { x, y };
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
                        source: "line",
                    });
                    state.path.currentPoint = { x, y };
                }
                break;
            }
            case "c": {
                const x = operandNumber(operands.at(4));
                const y = operandNumber(operands.at(5));
                appendCurveEndpointToPath(state.path, x, y);
                break;
            }
            case "v": {
                const x = operandNumber(operands.at(2));
                const y = operandNumber(operands.at(3));
                appendCurveEndpointToPath(state.path, x, y);
                break;
            }
            case "y": {
                const x = operandNumber(operands.at(2));
                const y = operandNumber(operands.at(3));
                appendCurveEndpointToPath(state.path, x, y);
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
                    state.path.subpathStartPoint = { x, y };
                }
                break;
            }
            case "h": {
                closeCurrentSubpath(state.path);
                break;
            }
            case "S":
                explicitEdges.push(...pathToEdges(state.path, state.ctm));
                state.path = createEmptyPathState();
                break;
            case "s":
            case "b":
            case "b*":
                closeCurrentSubpath(state.path);
                explicitEdges.push(...pathToEdges(state.path, state.ctm));
                state.path = createEmptyPathState();
                break;
            case "f":
            case "F":
            case "f*":
            case "B":
            case "B*":
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

export function handlePaintedObject(options: {
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
        const asset = extractPDFImageAsset(raw, resolver);
        const bbox = transformUnitSquare(ctm);
        occurrences.push({
            id: nextImageId(),
            type: asset.type,
            content: asset.content,
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

export function resolveMarkedContentProperties(
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

export function extractActualTextFromMarkedContent(properties: OperandDictionary | null): string | null {
    const raw = properties?.ActualText;
    const text = decodePDFTextOperand(raw);
    return text ? squashWhitespace(text) : null;
}

export function registerTextSequenceAdvance(state: MarkedContentState, count: number): void {
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

export function getActiveActualTextEntry(stack: MarkedContentEntry[]): MarkedContentEntry | null {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        const entry = stack[index];
        if (entry?.actualText) {
            return entry;
        }
    }

    return null;
}

export function countRenderedTextItems(value: Operand | undefined): number {
    if (typeof value === "string") {
        return Array.from(decodePDFStringBytes(Buffer.from(value, "latin1"))).length;
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

export function decodePDFTextOperand(value: Operand | undefined): string | null {
    if (typeof value === "string") {
        return value;
    }

    if (value instanceof Uint8Array) {
        return decodePDFStringBytes(value);
    }

    return null;
}

export function decodePDFStringBytes(bytes: Uint8Array): string {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        let output = "";
        for (let index = 2; index + 1 < bytes.length; index += 2) {
            output += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
        }
        return output;
    }

    return Buffer.from(bytes).toString("latin1");
}

export function operandInteger(value: Operand | undefined): number | null {
    return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function isOperandDictionary(value: Operand | undefined): value is OperandDictionary {
    return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

export function pdfObjectToOperand(object: unknown, resolver?: (ref: PDFRefLike) => unknown): OperandDictionary | null {
    if (!isPDFDict(object)) {
        return null;
    }

    const out: OperandDictionary = {};
    for (const [key, value] of object) {
        out[key.value] = pdfValueToOperand(value, resolver);
    }

    return out;
}

export function pdfValueToOperand(value: unknown, resolver?: (ref: PDFRefLike) => unknown): Operand {
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

export function transformUnitSquare(matrix: Matrix2D): BoundingBox {
    const points = [
        transformPoint(matrix, 0, 0),
        transformPoint(matrix, 1, 0),
        transformPoint(matrix, 0, 1),
        transformPoint(matrix, 1, 1),
    ];

    return boundingBoxFromPoints(points);
}

export function pathToEdges(path: PathState, matrix: Matrix2D): Edge[] {
    const edges: Edge[] = [];

    for (const segment of path.subpaths) {
        const start = transformPoint(matrix, segment.x0, segment.y0);
        const end = transformPoint(matrix, segment.x1, segment.y1);
        const edge = pointsToEdge(start, end, segment.source);
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

            const edge = pointsToEdge(start, end, "rect");
            if (edge) {
                edges.push(edge);
            }
        }
    }

    return edges;
}

export function appendCurveEndpointToPath(path: PathState, x: number | null, y: number | null): void {
    if (x === null || y === null || !path.currentPoint) {
        return;
    }

    path.subpaths.push({
        x0: path.currentPoint.x,
        y0: path.currentPoint.y,
        x1: x,
        y1: y,
        width: DEFAULT_LINE_WIDTH,
        source: "curve",
    });
    path.currentPoint = { x, y };
}

export function closeCurrentSubpath(path: PathState): void {
    if (!path.currentPoint || !path.subpathStartPoint) {
        path.currentPoint = null;
        return;
    }

    path.subpaths.push({
        x0: path.currentPoint.x,
        y0: path.currentPoint.y,
        x1: path.subpathStartPoint.x,
        y1: path.subpathStartPoint.y,
        width: DEFAULT_LINE_WIDTH,
        source: "line",
    });
    path.currentPoint = { ...path.subpathStartPoint };
}

export function pointsToEdge(
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

export function createTokenizer(bytes: Uint8Array): {
    next: () => { kind: "operand"; value: Operand } | { kind: "operator"; value: string } | null;
} {
    const text = Buffer.from(bytes).toString("latin1");
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

export function operandNumber(value: Operand | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function operandName(value: Operand | undefined): string | null {
    return typeof value === "string" ? value : null;
}

export function operandMatrix(values: Operand[]): Matrix2D | null {
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
