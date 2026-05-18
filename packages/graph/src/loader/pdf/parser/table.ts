import type {
    BoundingBox,
    Edge,
    LineSegmentBlock,
    PDFTableMode,
    PageText,
    SegmentedLine,
    TableBBox,
    TableBlock,
    TableCell,
    TableCellGroup,
    TableChar,
    TableEdge,
    TableIntersectionEdges,
    TableModelData,
    TablePage,
    TablePoint,
    TableSettings,
    TableWord,
    TextChar,
    TextLine,
    Word,
} from "./types";
import {
    EDGE_JOIN_TOLERANCE,
    EDGE_MIN_LENGTH,
    EDGE_SNAP_TOLERANCE,
    TABLE_DEFAULT_EDGE_MIN_LENGTH,
    TABLE_DEFAULT_EDGE_MIN_PREFILT,
    TABLE_DEFAULT_INTERSECTION_TOLERANCE,
    TABLE_DEFAULT_JOIN_TOLERANCE,
    TABLE_DEFAULT_MIN_WORDS_HORIZONTAL,
    TABLE_DEFAULT_MIN_WORDS_VERTICAL,
    TABLE_DEFAULT_SNAP_TOLERANCE,
    TABLE_DEFAULT_TEXT_TOLERANCE,
    TABLE_MAX_COLS,
    TABLE_MAX_ROWS,
    TABLE_MIN_CELLS,
    TABLE_MIN_COLS,
    TABLE_MIN_ROWS,
    TABLE_POINT_EQUALITY_TOLERANCE,
    TEXT_SEGMENT_GAP_RATIO,
    TEXT_SEGMENT_MIN_GAP,
} from "./constants";
import {
    average,
    getTop,
    intersects,
    intersectsAny,
    median,
    overlapLength,
    squashWhitespace,
    unionBoxes,
    uniqueSorted,
} from "./geometry";
import {
    buildVerticalTextLines,
    cleanupExtractedTextSpacing,
    dedupeTextChars,
    getAdaptiveTextXTolerance,
    getExpandedCharText,
    getLineText,
    getPreparedLineChars,
    inferLineDirection,
    inferTextCharDirection,
    isLikelyDuplicateTextChar,
    isScriptLikeTextChar,
    isWordBoundaryPunctuation,
    reconstructVerticalTextFromChars,
    shouldInsertSpaceBetweenChars,
    shouldKeepCharsJoined,
    sortTextChars,
    textCharBeginsNewWord,
} from "./text";

export function detectTables(
    pageText: PageText,
    words: Word[],
    lines: TextLine[],
    explicitEdges: Edge[],
    tableMode: PDFTableMode = "lines_strict"
): TableBlock[] {
    const tablePage = buildTablePage(pageText, words, explicitEdges);
    const tables: TableBlock[] = [];
    const proseLikeMultiColumn = explicitEdges.length === 0 && looksLikeMultiColumnProseLayout(lines, pageText.width);
    const strictLines = tableMode === "lines_strict";
    const nonStrictDrawnEdges = explicitEdges.filter((edge) => edge.source === "rect" || edge.source === "curve");

    appendUniqueTables(
        tables,
        buildTableBlocksFromModels(tablePage, tableFindTables(tablePage, tableDefaultSettings(tableMode)), "lines")
    );
    if (!strictLines && !proseLikeMultiColumn) {
        const rejectNonStrictEdges = strictLines ? nonStrictDrawnEdges : [];
        appendUniqueTables(
            tables,
            rejectTablesOverlappingNonStrictEdges(
                buildTableBlocksFromModels(
                    tablePage,
                    tableFindTables(tablePage, tableSettingsForStrategy("text", "text")),
                    "text"
                ),
                rejectNonStrictEdges
            )
        );
        appendUniqueTables(
            tables,
            rejectTablesOverlappingNonStrictEdges(
                detectWhitespaceSeparatedTables(
                    lines,
                    tables.map((table) => table.bbox)
                ),
                rejectNonStrictEdges
            )
        );
    }

    const legacyEdges = strictLines ? explicitEdges.filter((edge) => edge.source === "line") : explicitEdges;
    if (tables.length === 0 && legacyEdges.length > 0) {
        return detectTablesLegacy(pageText, legacyEdges);
    }

    tables.sort((a, b) => getTop(b.bbox) - getTop(a.bbox));

    return tables;
}

function rejectTablesOverlappingNonStrictEdges(tables: TableBlock[], edges: Edge[]): TableBlock[] {
    if (edges.length === 0) {
        return tables;
    }

    return tables.filter((table) => !tableOverlapsNonStrictEdgeGrid(table.bbox, edges));
}

function tableOverlapsNonStrictEdgeGrid(bbox: BoundingBox, edges: Edge[]): boolean {
    const overlapping = edges.filter((edge) => edgeOverlapsBox(edge, bbox));
    const verticalCount = overlapping.filter((edge) => edge.orientation === "vertical").length;
    const horizontalCount = overlapping.filter((edge) => edge.orientation === "horizontal").length;
    return verticalCount > 0 && horizontalCount > 0 && overlapping.length >= 3;
}

function edgeOverlapsBox(edge: Edge, bbox: BoundingBox): boolean {
    const boxStart = edge.orientation === "vertical" ? bbox.y : bbox.x;
    const boxEnd = edge.orientation === "vertical" ? getTop(bbox) : bbox.x + bbox.width;
    const boxMin = edge.orientation === "vertical" ? bbox.x : bbox.y;
    const boxMax = edge.orientation === "vertical" ? bbox.x + bbox.width : getTop(bbox);

    return (
        edge.position >= boxMin - EDGE_SNAP_TOLERANCE &&
        edge.position <= boxMax + EDGE_SNAP_TOLERANCE &&
        overlapLength(edge.start, edge.end, boxStart, boxEnd) > EDGE_SNAP_TOLERANCE
    );
}

export function looksLikeMultiColumnProseLayout(lines: TextLine[], pageWidth: number): boolean {
    const candidates = lines
        .filter((line) => inferLineDirection(line) === "horizontal")
        .map((line) => ({
            line,
            text: getLineText(line),
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

export function appendUniqueTables(tables: TableBlock[], candidates: TableBlock[]): void {
    for (const table of candidates) {
        if (!tables.some((existing) => intersects(existing.bbox, table.bbox, 0.5))) {
            tables.push(table);
        }
    }
}

export function buildTableBlocksFromModels(
    page: TablePage,
    models: TableModelData[],
    strategy: "lines" | "text"
): TableBlock[] {
    const tables: TableBlock[] = [];

    for (const model of models) {
        const rows = tidyExtractedTableRows(tableExtractRows(model, TABLE_DEFAULT_TEXT_TOLERANCE));
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
        const normalized = tidyTableCells(tableModelToCells(model, page.bbox.bottom));
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

export function detectTablesLegacy(pageText: PageText, explicitEdges: Edge[]): TableBlock[] {
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
        const normalized = tidyTableCells(tableCells);
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

export function mergeEdges(edges: Edge[]): Edge[] {
    const snapped = edges.filter((edge) => edge.end - edge.start >= EDGE_MIN_LENGTH).map((edge) => ({ ...edge }));

    for (let index = 0; index < snapped.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < snapped.length; otherIndex += 1) {
            const current = snapped[index];
            const other = snapped[otherIndex];
            if (!current || !other) {
                continue;
            }

            if (current.orientation !== other.orientation || current.source !== other.source) {
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
            last.source === edge.source &&
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

export function buildCells(verticalEdges: Edge[], horizontalEdges: Edge[], pageText: PageText): TableCell[] {
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

export function reconstructTableCellTextFromPage(pageText: PageText, bbox: BoundingBox): string {
    const chars = pageText.lines.flatMap((line) =>
        getPreparedLineChars(line).filter(
            (char) => wordCenterInBox(char.bbox, bbox) || intersects(char.bbox, bbox, 0.05)
        )
    );

    return reconstructTableCellText(chars);
}

export function reconstructTableCellText(chars: TextChar[]): string {
    if (chars.length === 0) {
        return "";
    }

    return reconstructTextLinesFromChars(chars, TABLE_DEFAULT_TEXT_TOLERANCE)
        .map((line) => cleanTableCellText(reconstructLogicalLineText(line)))
        .filter(Boolean)
        .join("\n")
        .trim();
}

export function wordCenterInBox(wordBox: BoundingBox, cellBox: BoundingBox): boolean {
    const centerX = wordBox.x + wordBox.width / 2;
    const centerY = wordBox.y + wordBox.height / 2;
    return (
        centerX >= cellBox.x - EDGE_SNAP_TOLERANCE &&
        centerX <= cellBox.x + cellBox.width + EDGE_SNAP_TOLERANCE &&
        centerY >= cellBox.y - EDGE_SNAP_TOLERANCE &&
        centerY <= cellBox.y + cellBox.height + EDGE_SNAP_TOLERANCE
    );
}

export function lineCenterInAnyBox(lineBox: BoundingBox, boxes: BoundingBox[]): boolean {
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

export function lineHasTableWords(lineWords: Word[], tableRegions: BoundingBox[]): boolean {
    if (lineWords.length === 0 || tableRegions.length === 0) {
        return false;
    }

    const tableWordCount = lineWords.filter((word) =>
        tableRegions.some((region) => wordCenterInBox(word.bbox, region))
    ).length;
    return tableWordCount / lineWords.length >= 0.5;
}

export function hasCoveringVerticalEdge(edges: Edge[], x: number, y0: number, y1: number): boolean {
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

export function hasCoveringHorizontalEdge(edges: Edge[], y: number, x0: number, x1: number): boolean {
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

export function groupCellsIntoTables(cells: TableCell[]): TableCell[][] {
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

export function cellsTouch(a: TableCell, b: TableCell): boolean {
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

export function buildMarkdownTable(cells: TableCell[]): string | null {
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

export function tidyTableCells(cells: TableCell[]): { cells: TableCell[]; rowCount: number; colCount: number } | null {
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

export function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|").trim();
}

export function extractWords(pageText: PageText): Word[] {
    const words: Word[] = [];

    for (let lineIndex = 0; lineIndex < pageText.lines.length; lineIndex += 1) {
        const line = pageText.lines[lineIndex];
        if (!line) {
            continue;
        }

        const chars = getPreparedLineChars(line);
        if (chars.length === 0) {
            const text = getLineText(line);
            if (text) {
                words.push({ text, bbox: line.bbox, lineIndex });
            }
            continue;
        }

        if (inferLineDirection(line, chars) === "vertical") {
            const text = getLineText(line);
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

export function pushWord(words: Word[], chars: TextChar[], lineIndex: number): void {
    if (chars.length === 0) {
        return;
    }

    const text = squashWhitespace(reconstructTextFromChars(chars));
    if (!text) {
        return;
    }

    const bbox = unionBoxes(chars.map((char) => char.bbox));
    if (!bbox) {
        return;
    }

    words.push({ text, bbox, lineIndex });
}

export function tableDefaultSettings(tableMode: PDFTableMode = "lines_strict"): TableSettings {
    return {
        VerticalStrategy: tableMode,
        HorizontalStrategy: tableMode,
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

export function tableSettingsForStrategy(
    vertical: TableSettings["VerticalStrategy"],
    horizontal: TableSettings["HorizontalStrategy"]
): TableSettings {
    return {
        ...tableDefaultSettings(),
        VerticalStrategy: vertical,
        HorizontalStrategy: horizontal,
    };
}

export function buildTablePage(pageText: PageText, words: Word[], explicitEdges: Edge[]): TablePage {
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

export function tableEdgeFromLayoutEdge(edge: Edge, pageHeight: number): TableEdge {
    if (edge.orientation === "vertical") {
        return {
            objectType: edge.source,
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
        objectType: edge.source,
        orientation: "h",
        x0: edge.start,
        x1: edge.end,
        top: pageHeight - edge.position,
        bottom: pageHeight - edge.position,
        width: edge.end - edge.start,
        height: 0,
    };
}

export function tableFindTables(page: TablePage, settings: TableSettings): TableModelData[] {
    const edges = tableGetTableEdges(page, settings);
    const intersections = tableEdgesToIntersections(edges, settings.IntersectionXTol, settings.IntersectionYTol);
    const cells = tableIntersectionsToCells(intersections);
    const tables = tableFilterTablesByStructure(tableCellsToTables(cells), settings.MinRows, settings.MinCols);
    return tables.map((cellsGroup) => ({ page, cells: cellsGroup }));
}

export function tableGetTableEdges(page: TablePage, settings: TableSettings): TableEdge[] {
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

export function tableExtendEdgesToNeighbors(
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

export function tableFilterTablesByStructure(tables: TableBBox[][], minRows: number, minCols: number): TableBBox[][] {
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

export function tableCountDistinctCoords(values: number[], tolerance: number): number {
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

export function tableMergeEdges(
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

export function tableSnapEdges(edges: TableEdge[], xTolerance: number, yTolerance: number): TableEdge[] {
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

export function tableSnapEdgesBy(edges: TableEdge[], attr: "x0" | "top", tolerance: number): TableEdge[] {
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

export function tableJoinEdgeGroup(edges: TableEdge[], orientation: "h" | "v", tolerance: number): TableEdge[] {
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

export function tableWordsToEdgesH(words: TableWord[], wordThreshold: number): TableEdge[] {
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

export function tableWordsToEdgesV(words: TableWord[], wordThreshold: number): TableEdge[] {
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

export function tableEdgesToIntersections(
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

export function tableIntersectionsToCells(
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

export function tableCellsToTables(cells: TableBBox[]): TableBBox[][] {
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

export function tableModelBBox(model: TableModelData): TableBBox {
    return model.cells.reduce((accumulator, cell) => ({
        x0: Math.min(accumulator.x0, cell.x0),
        top: Math.min(accumulator.top, cell.top),
        x1: Math.max(accumulator.x1, cell.x1),
        bottom: Math.max(accumulator.bottom, cell.bottom),
    }));
}

export function tableModelToCells(model: TableModelData, pageHeight: number): TableCell[] {
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

export function tableModelRows(model: TableModelData): TableCellGroup[] {
    return tableGetRowsOrCols(model, true);
}

export function tableGetRowsOrCols(model: TableModelData, rows: boolean): TableCellGroup[] {
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

export function tableExtractRows(model: TableModelData, textTolerance: number): Array<Array<string | null>> {
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

export function tableMakeCellGroup(cells: Array<TableBBox | null>): TableCellGroup {
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

export function tableExtractCharsText(chars: TableChar[], tolerance: number): string {
    if (chars.length === 0) {
        return "";
    }

    const lines = reconstructTextLinesFromChars(chars.map(tableCharToTextChar), tolerance);
    return lines
        .map((line) => cleanTableCellText(reconstructLogicalLineText(line)))
        .filter(Boolean)
        .join("\n")
        .trim();
}

export function reconstructTextLinesFromChars(chars: TextChar[], tolerance: number): TextChar[][] {
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

export function reconstructHorizontalTextLines(chars: TextChar[], tolerance: number): TextChar[][] {
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

export function reconstructLogicalLineText(chars: TextChar[]): string {
    if (chars.length === 0) {
        return "";
    }

    const verticalCount = chars.filter((char) => inferTextCharDirection(char) === "vertical").length;
    if (verticalCount >= Math.ceil(chars.length * 0.6)) {
        return reconstructVerticalTextFromChars(chars);
    }

    return cleanupExtractedTextSpacing(reconstructTextFromChars(chars));
}

export function tableCharToTextChar(char: TableChar): TextChar {
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

export function tableClusterWords(
    words: TableWord[],
    key: (word: TableWord) => number,
    tolerance: number
): TableWord[][] {
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

export function tableWordsToBBox(words: TableWord[]): TableBBox {
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

export function tableBBoxOverlap(a: TableBBox, b: TableBBox): TableBBox | null {
    const left = Math.max(a.x0, b.x0);
    const right = Math.min(a.x1, b.x1);
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right - left >= 0 && bottom - top >= 0 && right + bottom - left - top > 0) {
        return { x0: left, top, x1: right, bottom };
    }
    return null;
}

export function tableFilterEdges(
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

export function tableResizeEdge(edge: TableEdge, key: "x0" | "x1" | "top" | "bottom", value: number): TableEdge {
    const updated = { ...edge, [key]: value };
    updated.width = updated.x1 - updated.x0;
    updated.height = updated.bottom - updated.top;
    return updated;
}

export function tableEdgeProp(edge: TableEdge, attr: "x0" | "x1" | "top" | "bottom"): number {
    return edge[attr];
}

export function tableBBoxCoord(bbox: TableBBox, axis: number): number {
    return axis === 0 ? bbox.x0 : bbox.top;
}

export function tableMinCorner(cells: TableBBox[]): { top: number; x0: number } {
    return cells.reduce(
        (accumulator, cell) => ({
            top: Math.min(accumulator.top, cell.top),
            x0: Math.min(accumulator.x0, cell.x0),
        }),
        { top: cells[0]!.top, x0: cells[0]!.x0 }
    );
}

export function tableBBoxKey(bbox: TableBBox): string {
    return `${bbox.x0.toFixed(6)}|${bbox.top.toFixed(6)}|${bbox.x1.toFixed(6)}|${bbox.bottom.toFixed(6)}`;
}

export function tablePointKey(point: TablePoint): string {
    return `${point.x.toFixed(6)}|${point.y.toFixed(6)}`;
}

export function tableAlmostEqual(a: number, b: number, epsilon: number): boolean {
    return Math.abs(a - b) <= epsilon;
}

export function tableRowsToMarkdown(rows: Array<Array<string | null>>): string | null {
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

export function tableIsLikelyTabular(rows: Array<Array<string | null>>): boolean {
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
            const text = squashWhitespace(row[column] ?? "");
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

export function tablePassesTextOnlyHeuristics(rows: Array<Array<string | null>>): boolean {
    if (rows.length < 2) {
        return false;
    }

    const colCount = Math.max(...rows.map((row) => row.length));
    const flattened = rows.flatMap((row) => row.map((cell) => squashWhitespace(cell ?? "")).filter(Boolean));
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

export function tidyExtractedTableRows(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    let normalized = rows.map((row) => row.map((cell) => cleanTableCellText(cell ?? "") || null));
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
                header[only.index] = squashWhitespace([current, only.cell].filter(Boolean).join(" ")) || current;
                normalized.splice(1, 1);
            }
        }
    }

    return normalized;
}

export function cleanTableCellText(value: string): string {
    return squashWhitespace(value)
        .replace(/([A-Za-zÄÖÜäöüß])-\s+(?=[a-zäöüß])/g, "$1")
        .trim();
}

export function detectWhitespaceSeparatedTables(lines: TextLine[], excludedRegions: BoundingBox[]): TableBlock[] {
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

export function segmentLine(line: TextLine, lineIndex: number): SegmentedLine | null {
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

export function textCharsToSegment(chars: TextChar[]): LineSegmentBlock | null {
    if (chars.length === 0) {
        return null;
    }

    const bbox = unionBoxes(chars.map((char) => char.bbox));
    const text = cleanTableCellText(reconstructTextFromChars(chars));
    if (!bbox || !text) {
        return null;
    }

    return { text, bbox };
}

export function reconstructTextFromChars(chars: TextChar[]): string {
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

export function shouldReplaceOverlappingChar(previous: TextChar, current: TextChar): boolean {
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

export function canJoinSegmentedLines(
    previous: SegmentedLine,
    candidate: SegmentedLine,
    group: SegmentedLine[]
): boolean {
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

export function segmentedLinesToTable(group: SegmentedLine[]): TableBlock | null {
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
            row[index] = cleanTableCellText(joinUniqueTableParts(current ?? "", segment.text)) || current;
        }
        return row;
    });

    const normalizedRows = tidyExtractedTableRows(rows);
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

export function clusterNumericPositions(values: number[], tolerance: number): number[] {
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

export function nearestColumnIndex(x: number, anchors: number[]): number | null {
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

export function tablePassesWhitespaceTableHeuristics(rows: Array<Array<string | null>>): boolean {
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

export function tableHasLeaderPatterns(rows: Array<Array<string | null>>, sampleRowCount: number): boolean {
    return rows
        .slice(0, sampleRowCount)
        .some((row) => row.some((cell) => /(?:\.{3,}|_{3,}|\s\.\s\.\s\.)/.test(cell ?? "")));
}

export function tableCountStableColumns(rows: Array<Array<string | null>>): number {
    const colCount = Math.max(0, ...rows.map((row) => row.length));
    let stable = 0;

    for (let columnIndex = 0; columnIndex < colCount; columnIndex += 1) {
        const values = rows.map((row) => squashWhitespace(row[columnIndex] ?? "")).filter(Boolean);

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

export function tableCellSignature(value: string): string {
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

export function tableCountDenseDataRows(rows: Array<Array<string | null>>): number {
    const colCount = Math.max(0, ...rows.map((row) => row.length));
    const minimumFilled = Math.max(2, Math.ceil(colCount * 0.6));
    return rows.slice(1).filter((row) => row.filter(Boolean).length >= minimumFilled).length;
}

export function tableLooksLikeReferenceList(rows: Array<Array<string | null>>): boolean {
    const colCount = Math.max(0, ...rows.map((row) => row.length));
    if (colCount < 2 || colCount > 4 || rows.length < 4) {
        return false;
    }

    const dataRows = rows.slice(1);
    const citationRows = dataRows.filter((row) => isReferenceMarker(squashWhitespace(row[0] ?? ""))).length;
    if (citationRows < Math.ceil(dataRows.length * 0.6)) {
        return false;
    }

    const descriptiveRows = dataRows.filter((row) => {
        const trailing = squashWhitespace(row.slice(1).filter(Boolean).join(" "));
        return trailing.length > 24;
    }).length;

    return descriptiveRows >= Math.ceil(dataRows.length * 0.6);
}

export function isReferenceMarker(value: string): boolean {
    return /^[[(]?\d+[\]).]?$/.test(value);
}

export function padTableRows(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    const width = Math.max(0, ...rows.map((row) => row.length));
    return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? null));
}

export function mergeHeaderRows(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    if (rows.length < 3) {
        return rows;
    }

    let headerCount = 1;
    for (let index = 1; index < Math.min(3, rows.length); index += 1) {
        const row = rows[index] ?? [];
        const values = row.map((cell) => squashWhitespace(cell ?? "")).filter(Boolean);
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
            cleanTableCellText(
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

export function removeEmptyTableColumns(rows: Array<Array<string | null>>): Array<Array<string | null>> {
    if (rows.length === 0) {
        return rows;
    }

    const width = Math.max(...rows.map((row) => row.length));
    const keep = Array.from({ length: width }, (_, index) => rows.some((row) => Boolean(row[index])));
    return rows.map((row) => row.filter((_, index) => keep[index]));
}

export function findMergeableColumnIndex(rows: Array<Array<string | null>>): number | null {
    if (rows.length === 0) {
        return null;
    }

    const width = Math.max(...rows.map((row) => row.length));
    for (let index = 0; index < width - 1; index += 1) {
        let leftCount = 0;
        let rightCount = 0;
        let overlapCount = 0;

        for (const row of rows) {
            const left = squashWhitespace(row[index] ?? "");
            const right = squashWhitespace(row[index + 1] ?? "");
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

export function mergeAdjacentTableColumns(
    rows: Array<Array<string | null>>,
    index: number
): Array<Array<string | null>> {
    return rows.map((row) => {
        const left = squashWhitespace(row[index] ?? "");
        const right = squashWhitespace(row[index + 1] ?? "");
        const merged = squashWhitespace(joinUniqueTableParts(left, right));
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

export function joinUniqueTableParts(left: string, right: string): string {
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

export function mergeWrappedTableRows(rows: Array<Array<string | null>>): Array<Array<string | null>> {
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
            next[0] = squashWhitespace(`${text.slice(0, -1)}${next[0]}`) || next[0];
            merged[index] = row.map(() => null);
            continue;
        }

        if ((/^[a-zäöü]/.test(text) || /^und\b/i.test(text)) && previous?.[0]) {
            previous[0] = squashWhitespace(`${previous[0]} ${text}`) || previous[0];
            merged[index] = row.map(() => null);
            continue;
        }

        if (nextHasValue && next?.[0]) {
            next[0] = squashWhitespace(`${text} ${next[0]}`) || next[0];
            merged[index] = row.map(() => null);
            continue;
        }

        if (previousHasValue && previous?.[0]) {
            previous[0] = squashWhitespace(`${previous[0]} ${text}`) || previous[0];
            merged[index] = row.map(() => null);
        }
    }

    return merged;
}

export function tableBBoxToBoundingBox(bbox: TableBBox, pageHeight: number): BoundingBox {
    return {
        x: bbox.x0,
        y: pageHeight - bbox.bottom,
        width: bbox.x1 - bbox.x0,
        height: bbox.bottom - bbox.top,
    };
}
