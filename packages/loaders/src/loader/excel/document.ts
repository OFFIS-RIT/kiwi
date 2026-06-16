import { read, utils, type WorkBook, type WorkSheet } from "xlsx";
import { getMimeTypeForPath, parseContentTypes, resolveZipPath } from "../ooxml/package";
import { extractEmbeddedOfficeDocumentText, isEmbeddedOfficeDocumentType, toArrayBuffer } from "../ooxml/embedded";
import {
    childElements,
    findDescendants,
    findFirstDescendant,
    getAttribute,
    getDocumentRoot,
    getLocalName,
    parseXml,
} from "../ooxml/xml";
import { blocksToPlainText } from "../doc/blocks";
import { slideBlocksToPlainText } from "../ppt/blocks";
import { rowsToMarkdown } from "./render";
import type { ExcelResult, ExcelSheetResult } from "./types";

type ExtractExcelOptions = {
    depth?: number;
};

type SheetVisibility = {
    hiddenRows: Set<number>;
    hiddenCols: Set<number>;
};

type SheetMatrix = {
    rows: string[][];
    hasHeader: boolean;
    colCount: number;
};

export async function extractExcel(content: ArrayBuffer, options: ExtractExcelOptions = {}): Promise<ExcelResult> {
    const workbook = readWorkbook(content);
    const worksheetPartPaths = getWorksheetPartPaths(workbook);
    const sheets: ExcelSheetResult[] = [];
    const contentTypes = parseContentTypes(getWorkbookFileText(workbook, "[Content_Types].xml"));

    for (const [index, sheetName] of workbook.SheetNames.entries()) {
        const sheet = await renderSheet(
            workbook,
            sheetName,
            index,
            worksheetPartPaths.get(sheetName) ?? null,
            contentTypes,
            options
        );
        if (sheet) {
            sheets.push(sheet);
        }
    }

    return {
        text: sheets.map((sheet) => sheet.text).join("\n\n"),
        sheets,
    };
}

function readWorkbook(content: ArrayBuffer): WorkBook {
    const bytes = new Uint8Array(content);
    if (!isLikelyWorkbook(bytes)) {
        throw new Error("Invalid Excel workbook content");
    }

    return read(bytes, {
        type: "array",
        cellText: true,
        cellDates: true,
        cellStyles: true,
        cellHTML: true,
        bookFiles: true,
    });
}

function isLikelyWorkbook(bytes: Uint8Array): boolean {
    const isZipBasedWorkbook = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const isLegacyXLSWorkbook = bytes[0] === 0xd0 && bytes[1] === 0xcf;
    return isZipBasedWorkbook || isLegacyXLSWorkbook;
}

async function renderSheet(
    workbook: WorkBook,
    sheetName: string,
    index: number,
    sheetPath: string | null,
    contentTypes: ReturnType<typeof parseContentTypes>,
    options: ExtractExcelOptions
): Promise<ExcelSheetResult | null> {
    if (isHiddenSheet(workbook, index)) {
        return null;
    }

    const worksheet = workbook.Sheets[sheetName];
    const visibility: SheetVisibility = worksheet
        ? getWorksheetVisibility(worksheet)
        : { hiddenRows: new Set<number>(), hiddenCols: new Set<number>() };
    const matrix = worksheet ? buildSheetMatrix(worksheet, visibility) : { rows: [], hasHeader: false, colCount: 0 };
    const annotations = await extractWorksheetAnnotations(
        workbook,
        worksheet,
        sheetPath,
        visibility,
        sheetName,
        contentTypes,
        options
    );
    if (matrix.rows.length === 0 && annotations.beforeTable.length === 0 && annotations.afterTable.length === 0) {
        return null;
    }

    const table = matrix.rows.length > 0 ? rowsToMarkdown(matrix.rows, { hasHeader: matrix.hasHeader }) : "";
    const text = [
        `## Sheet: ${cleanSheetName(sheetName)}`,
        ...annotations.beforeTable,
        table,
        ...annotations.afterTable,
    ]
        .filter(Boolean)
        .join("\n\n");

    return {
        name: sheetName,
        text,
        rowCount: matrix.rows.length,
        colCount: matrix.colCount,
    };
}

function isHiddenSheet(workbook: WorkBook, index: number): boolean {
    const sheet = workbook.Workbook?.Sheets?.[index];
    return sheet?.Hidden === 1 || sheet?.Hidden === 2;
}

function buildSheetMatrix(worksheet: WorkSheet, visibility: SheetVisibility): SheetMatrix {
    const ref = worksheet["!ref"];
    if (!ref) {
        return { rows: [], hasHeader: false, colCount: 0 };
    }

    const range = utils.decode_range(ref);
    const area = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    const useSparseCoordinates = area > 50_000;
    const merges = worksheet["!merges"] ?? [];
    const rowIndexes = useSparseCoordinates
        ? collectSparseIndexes(worksheet, merges, visibility.hiddenRows, "row", range)
        : Array.from({ length: range.e.r - range.s.r + 1 }, (_row, index) => range.s.r + index).filter(
              (rowIndex) => !visibility.hiddenRows.has(rowIndex)
          );
    const colIndexes = useSparseCoordinates
        ? collectSparseIndexes(worksheet, merges, visibility.hiddenCols, "col", range)
        : Array.from({ length: range.e.c - range.s.c + 1 }, (_col, index) => range.s.c + index).filter(
              (colIndex) => !visibility.hiddenCols.has(colIndex)
          );
    const rows = rowIndexes
        .map((rowIndex) =>
            colIndexes.map((colIndex) => {
                if (isMergedContinuationCell(worksheet, rowIndex, colIndex)) {
                    return "";
                }

                const address = utils.encode_cell({ r: rowIndex, c: colIndex });
                return normalizeCellValue(getCellDisplayValue(worksheet, address, new Set()));
            })
        )
        .map(trimTrailingEmptyCells)
        .filter((row) => row.some((cell) => cell.length > 0));
    const colCount = Math.max(0, ...rows.map((row) => row.length));
    const normalizedRows =
        colCount === 0
            ? []
            : rows.map((row) => {
                  const nextRow = [...row];
                  while (nextRow.length < colCount) {
                      nextRow.push("");
                  }

                  return nextRow;
              });

    return {
        rows: normalizedRows,
        hasHeader: detectHeaderRow(normalizedRows),
        colCount,
    };
}

function getCellDisplayValue(worksheet: WorkSheet, address: string, visited: Set<string>): unknown {
    const cell = worksheet[address];
    if (typeof cell !== "object" || cell === null) {
        return "";
    }

    const value = cell as { w?: unknown; v?: unknown; l?: { Target?: string }; f?: string; h?: string };
    const display = typeof value.w === "string" ? value.w : value.v;
    const text = normalizeCellValue(display);
    const target = normalizeHyperlinkTarget(value.l?.Target);
    if (target && text) {
        return `[${text}](${target})`;
    }

    if (display !== undefined && display !== null && text) {
        return text;
    }

    if (typeof value.f === "string" && value.f.length > 0) {
        const evaluated = evaluateFormula(value.f, worksheet, visited, address);
        if (evaluated !== null && evaluated !== undefined && evaluated !== "") {
            return evaluated;
        }

        return `=${value.f}`;
    }

    if (typeof value.h === "string" && value.h.length > 0) {
        return value.h.replace(/<[^>]+>/g, " ");
    }

    return display;
}

function normalizeCellValue(cell: unknown): string {
    if (cell === null || cell === undefined) {
        return "";
    }

    if (cell instanceof Date) {
        return cell.toISOString();
    }

    return String(cell).replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function cleanSheetName(name: string): string {
    return name.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function trimTrailingEmptyCells(row: string[]): string[] {
    const nextRow = [...row];
    while (nextRow.length > 0 && nextRow[nextRow.length - 1] === "") {
        nextRow.pop();
    }

    return nextRow;
}

function collectSparseIndexes(
    worksheet: WorkSheet,
    merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>,
    hidden: Set<number>,
    axis: "row" | "col",
    range: { s: { r: number; c: number }; e: { r: number; c: number } }
): number[] {
    const indexes = new Set<number>();
    for (const key of Object.keys(worksheet)) {
        if (!isWorksheetCellAddress(key)) {
            continue;
        }

        const address = utils.decode_cell(key);
        const value = axis === "row" ? address.r : address.c;
        indexes.add(value);
    }

    for (const merge of merges) {
        const start = axis === "row" ? merge.s.r : merge.s.c;
        const end = axis === "row" ? merge.e.r : merge.e.c;
        for (let value = start; value <= end; value += 1) {
            indexes.add(value);
        }
    }

    const min = axis === "row" ? range.s.r : range.s.c;
    const max = axis === "row" ? range.e.r : range.e.c;
    return [...indexes]
        .filter((value) => value >= min && value <= max && !hidden.has(value))
        .sort((left, right) => left - right);
}

function isMergedContinuationCell(worksheet: WorkSheet, rowIndex: number, colIndex: number): boolean {
    return (worksheet["!merges"] ?? []).some(
        (merge) =>
            rowIndex >= merge.s.r &&
            rowIndex <= merge.e.r &&
            colIndex >= merge.s.c &&
            colIndex <= merge.e.c &&
            (rowIndex !== merge.s.r || colIndex !== merge.s.c)
    );
}

function detectHeaderRow(rows: string[][]): boolean {
    if (rows.length < 2) {
        return false;
    }

    const firstRow = rows[0] ?? [];
    const secondRow = rows[1] ?? [];
    if (firstRow.length === 0 || firstRow.some((cell) => cell.length === 0)) {
        return false;
    }

    const firstRowLooksNumeric = firstRow.every((cell) => /^[-+]?\d+(?:[.,]\d+)?$/.test(cell));
    const secondRowLooksDifferent = secondRow.some((cell) => /^[-+]?\d+(?:[.,]\d+)?$/.test(cell) || cell.length === 0);
    return !firstRowLooksNumeric && secondRowLooksDifferent;
}

function normalizeHyperlinkTarget(value: string | undefined): string | null {
    if (!value) {
        return null;
    }

    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(value)) {
        return value;
    }

    return null;
}

function evaluateFormula(
    formula: string,
    worksheet: WorkSheet,
    visited: Set<string>,
    address: string
): string | number | null {
    if (visited.has(address)) {
        return null;
    }

    visited.add(address);
    try {
        const normalized = formula.replace(/^=/, "").trim();
        if (!normalized) {
            return null;
        }

        const expanded = resolveFormulaFunctions(normalized, worksheet, visited);
        const substituted = expanded.replace(/\$?([A-Z]{1,3})\$?(\d+)/gi, (match) => {
            const raw = getFormulaScalarValue(`${match.replace(/\$/g, "")}`, worksheet, visited);
            if (typeof raw === "number") {
                return String(raw);
            }

            if (typeof raw === "string" && /^[-+]?\d+(?:\.\d+)?$/.test(raw)) {
                return raw;
            }

            return "0";
        });

        if (!/^[\d+\-*/^().,\s<>=!&"]+$/.test(substituted)) {
            return null;
        }

        const expression = substituted.replace(/\^/g, "**").replace(/&/g, "+");
        const value = Function(`"use strict"; return (${expression});`)() as unknown;
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        return typeof value === "string" ? value : null;
    } catch {
        return null;
    } finally {
        visited.delete(address);
    }
}

function resolveFormulaFunctions(expression: string, worksheet: WorkSheet, visited: Set<string>): string {
    let current = expression;
    const functionPattern = /([A-Z][A-Z0-9._]*)\(([^()]*)\)/gi;

    while (functionPattern.test(current)) {
        current = current.replace(functionPattern, (_match, rawName: string, rawArgs: string) => {
            const name = rawName.toUpperCase();
            const args = splitFormulaArguments(rawArgs).map((argument) =>
                resolveFormulaArgument(argument, worksheet, visited)
            );
            const flatArgs = args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg]));
            const numbers = flatArgs.flatMap((value) => {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? [parsed] : [];
            });

            switch (name) {
                case "SUM":
                    return String(numbers.reduce((sum, value) => sum + value, 0));
                case "AVERAGE":
                    return String(
                        numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0
                    );
                case "MIN":
                    return String(numbers.length > 0 ? Math.min(...numbers) : 0);
                case "MAX":
                    return String(numbers.length > 0 ? Math.max(...numbers) : 0);
                case "COUNT":
                    return String(numbers.length);
                case "COUNTA":
                    return String(flatArgs.filter((value) => normalizeCellValue(value).length > 0).length);
                case "CONCAT":
                    return JSON.stringify(flatArgs.map((value) => normalizeCellValue(value)).join(""));
                case "IF": {
                    const [condition, truthy, falsy] = args;
                    const chosen = isTruthyFormulaValue(condition) ? truthy : falsy;
                    return typeof chosen === "string" ? JSON.stringify(chosen) : String(chosen ?? "");
                }
                default:
                    throw new Error(`Unsupported formula function: ${name}`);
            }
        });
    }

    return current;
}

function splitFormulaArguments(value: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index] ?? "";
        if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth = Math.max(0, depth - 1);
        } else if (char === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
            continue;
        }

        current += char;
    }

    if (current.trim().length > 0 || value.includes(",")) {
        parts.push(current.trim());
    }

    return parts;
}

function resolveFormulaArgument(
    argument: string,
    worksheet: WorkSheet,
    visited: Set<string>
): Array<string | number> | string | number {
    if (/^\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+$/i.test(argument)) {
        const [start = "", end = ""] = argument.split(":");
        return getRangeValues(start.replace(/\$/g, ""), end.replace(/\$/g, ""), worksheet, visited);
    }

    if (/^\$?[A-Z]{1,3}\$?\d+$/i.test(argument)) {
        return getFormulaScalarValue(argument.replace(/\$/g, ""), worksheet, visited);
    }

    if (/^".*"$/.test(argument)) {
        return argument.slice(1, -1);
    }

    const numeric = Number(argument);
    if (Number.isFinite(numeric)) {
        return numeric;
    }

    return argument;
}

function getRangeValues(
    start: string,
    end: string,
    worksheet: WorkSheet,
    visited: Set<string>
): Array<string | number> {
    if (!start || !end) {
        return [];
    }

    const range = utils.decode_range(`${start}:${end}`);
    const values: Array<string | number> = [];
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
        for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
            values.push(getFormulaScalarValue(utils.encode_cell({ r: rowIndex, c: colIndex }), worksheet, visited));
        }
    }

    return values;
}

function getFormulaScalarValue(address: string, worksheet: WorkSheet, visited: Set<string>): string | number {
    const cell = worksheet[address] as { v?: unknown; w?: unknown; f?: string } | undefined;
    if (!cell) {
        return 0;
    }

    if (typeof cell.w === "string" && /^[-+]?\d+(?:\.\d+)?$/.test(cell.w)) {
        return Number(cell.w);
    }

    if (typeof cell.v === "number") {
        return cell.v;
    }

    if (typeof cell.f === "string") {
        return evaluateFormula(cell.f, worksheet, visited, address) ?? 0;
    }

    return normalizeCellValue(typeof cell.w === "string" ? cell.w : cell.v);
}

function isTruthyFormulaValue(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some((entry) => isTruthyFormulaValue(entry));
    }

    if (typeof value === "number") {
        return value !== 0;
    }

    return normalizeCellValue(value).length > 0;
}

function getWorksheetVisibility(worksheet: WorkSheet): { hiddenRows: Set<number>; hiddenCols: Set<number> } {
    return {
        hiddenRows: new Set((worksheet["!rows"] ?? []).flatMap((row, index) => (row?.hidden ? [index] : []))),
        hiddenCols: new Set((worksheet["!cols"] ?? []).flatMap((col, index) => (col?.hidden ? [index] : []))),
    };
}

async function extractWorksheetAnnotations(
    workbook: WorkBook,
    worksheet: WorkSheet | undefined,
    sheetPath: string | null,
    visibility: SheetVisibility,
    sheetName: string,
    contentTypes: ReturnType<typeof parseContentTypes>,
    options: ExtractExcelOptions
): Promise<{ beforeTable: string[]; afterTable: string[] }> {
    return {
        beforeTable: extractWorksheetHeaderFooter(workbook, sheetPath, "header"),
        afterTable: [
            ...extractWorksheetComments(worksheet, visibility),
            ...(await extractWorksheetRelatedPartText(workbook, sheetPath, sheetName, contentTypes, options)),
            ...extractWorksheetHeaderFooter(workbook, sheetPath, "footer"),
        ],
    };
}

function extractWorksheetComments(worksheet: WorkSheet | undefined, visibility: SheetVisibility): string[] {
    if (!worksheet) {
        return [];
    }

    return Object.entries(worksheet)
        .filter(([key, cell]) => isWorksheetCellAddress(key) && hasVisibleComments(cell))
        .sort(([left], [right]) => compareCellAddresses(left, right))
        .flatMap(([address, cell]) => {
            const decoded = utils.decode_cell(address);
            if (visibility.hiddenRows.has(decoded.r) || visibility.hiddenCols.has(decoded.c)) {
                return [];
            }

            const comments = (cell as { c?: Array<{ a?: string; t?: string }> }).c ?? [];
            return comments.flatMap((comment) => {
                const text = normalizeCellValue(comment.t);
                if (!text) {
                    return [];
                }

                const author = normalizeAnnotationValue(comment.a);
                const label = author ? `Comment ${address} by ${author}` : `Comment ${address}`;
                return [`[${label}: ${text}]`];
            });
        });
}

function extractWorksheetHeaderFooter(
    workbook: WorkBook,
    sheetPath: string | null,
    kind: "header" | "footer"
): string[] {
    if (!sheetPath) {
        return [];
    }

    const sheetXml = getWorkbookFileText(workbook, sheetPath);
    if (!sheetXml) {
        return [];
    }

    const root = getDocumentRoot(parseXml(sheetXml));
    const headerFooter = root ? findFirstDescendant(root, "headerFooter") : null;
    if (!headerFooter) {
        return [];
    }

    const labels =
        kind === "header"
            ? new Map([
                  ["oddHeader", "Header"],
                  ["firstHeader", "First Header"],
                  ["evenHeader", "Even Header"],
              ])
            : new Map([
                  ["oddFooter", "Footer"],
                  ["firstFooter", "First Footer"],
                  ["evenFooter", "Even Footer"],
              ]);

    const blocks: string[] = [];
    for (const child of childElements(headerFooter)) {
        const name = getLocalName(child);
        const label = labels.get(name);
        if (!label) {
            continue;
        }

        const text = decodeHeaderFooterText(child.textContent ?? "");
        if (text) {
            blocks.push(`[${label}: ${text}]`);
        }
    }

    return blocks;
}

function decodeHeaderFooterText(value: string): string {
    if (!value) {
        return "";
    }

    const sections = splitHeaderFooterSections(value)
        .map((section) => cleanHeaderFooterSection(section))
        .filter((section) => section.length > 0);

    return sections.join(" | ");
}

function splitHeaderFooterSections(value: string): string[] {
    const sections = { L: "", C: "", R: "" };
    let current: keyof typeof sections = "C";

    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "&") {
            const marker = value[index + 1];
            if ((marker === "L" || marker === "C" || marker === "R") && value[index + 2] !== "&") {
                current = marker;
                index += 1;
                continue;
            }
        }

        sections[current] += value[index] ?? "";
    }

    return [sections.L, sections.C, sections.R];
}

function cleanHeaderFooterSection(value: string): string {
    return value
        .replace(/\r/g, "")
        .replace(/&&/g, "&")
        .replace(/&"[^"]*"/g, "")
        .replace(/&K[0-9A-F]{6}/gi, "")
        .replace(/&G/gi, "[Image]")
        .replace(/&P/gi, "[Page]")
        .replace(/&N/gi, "[Pages]")
        .replace(/&D/gi, "[Date]")
        .replace(/&T/gi, "[Time]")
        .replace(/&F/gi, "[File]")
        .replace(/&A/gi, "[Sheet]")
        .replace(/&Z/gi, "[Path]")
        .replace(/&\d{1,3}/g, "")
        .replace(/&[BEIUSXY]/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

async function extractWorksheetRelatedPartText(
    workbook: WorkBook,
    sheetPath: string | null,
    sheetName: string,
    contentTypes: ReturnType<typeof parseContentTypes>,
    options: ExtractExcelOptions
): Promise<string[]> {
    if (!sheetPath || (options.depth ?? 0) >= 2) {
        return [];
    }

    const root = getWorkbookRoot(workbook, sheetPath);
    if (!root) {
        return [];
    }

    const relationshipTargets = getWorkbookPartRelationships(workbook, sheetPath);
    const relationshipIds = new Set<string>();
    for (const node of findDescendants(root, "drawing")) {
        const relationshipId = getAttribute(node, "r:id", "id");
        if (relationshipId) {
            relationshipIds.add(relationshipId);
        }
    }

    for (const node of findDescendants(root, "legacyDrawing")) {
        const relationshipId = getAttribute(node, "r:id", "id");
        if (relationshipId) {
            relationshipIds.add(relationshipId);
        }
    }

    const parts = [...relationshipIds]
        .map((relationshipId) => relationshipTargets.get(relationshipId))
        .filter((target): target is string => Boolean(target));
    const texts = (
        await Promise.all(parts.map((target) => readWorkbookRelatedPartText(workbook, target, contentTypes, options)))
    )
        .filter((text) => text.length > 0)
        .map((text) => `[Related ${cleanSheetName(sheetName)}: ${text}]`);

    if (texts.length > 0) {
        return texts;
    }

    const partType = getLocalName(root);
    if (partType === "chartsheet") {
        const chartText = squashRelatedPartText(root.textContent ?? "");
        return chartText ? [`[Related ${cleanSheetName(sheetName)}: ${chartText}]`] : [];
    }

    return [];
}

async function readWorkbookRelatedPartText(
    workbook: WorkBook,
    partPath: string,
    contentTypes: ReturnType<typeof parseContentTypes>,
    options: ExtractExcelOptions,
    seenPartPaths: Set<string> = new Set()
): Promise<string> {
    if ((options.depth ?? 0) >= 2 || seenPartPaths.has(partPath)) {
        return "";
    }

    const nextSeenPartPaths = new Set(seenPartPaths);
    nextSeenPartPaths.add(partPath);
    const contentType = getMimeTypeForPath(contentTypes, partPath).toLowerCase();
    if (isEmbeddedOfficeDocumentType(contentType, partPath)) {
        const binary = getWorkbookFileBinary(workbook, partPath);
        if (!binary) {
            return "";
        }

        return extractEmbeddedWorkbookPartText(binary, partPath, contentType, options);
    }

    const root = getWorkbookRoot(workbook, partPath);
    if (!root) {
        return "";
    }

    const relationships = getWorkbookPartRelationships(workbook, partPath);
    const childText = (
        await Promise.all(
            [...relationships.values()].map((target) =>
                readWorkbookRelatedPartText(
                    workbook,
                    target,
                    contentTypes,
                    { depth: (options.depth ?? 0) + 1 },
                    nextSeenPartPaths
                )
            )
        )
    )
        .filter((value) => value.length > 0)
        .join(" ");

    return squashRelatedPartText(`${root.textContent ?? ""} ${childText}`);
}

async function extractEmbeddedWorkbookPartText(
    content: Uint8Array,
    partPath: string,
    contentType: string,
    options: ExtractExcelOptions
): Promise<string> {
    return extractEmbeddedOfficeDocumentText({
        content: toArrayBuffer(content),
        partPath,
        contentType,
        depth: options.depth ?? 0,
        readers: {
            docx: async (embeddedContent, nextOptions) => {
                const { parseDOCX } = await import("../doc/document");
                const parsed = await parseDOCX(embeddedContent, {
                    ocr: false,
                    markdown: true,
                    depth: nextOptions.depth,
                });
                return blocksToPlainText(parsed.blocks);
            },
            pptx: async (embeddedContent, nextOptions) => {
                const { parsePPT } = await import("../ppt/document");
                const parsed = await parsePPT(embeddedContent, {
                    ocr: false,
                    markdown: true,
                    depth: nextOptions.depth,
                });
                return parsed.slides.map((slide) => slideBlocksToPlainText(slide.blocks)).join(" ");
            },
            xlsx: async (embeddedContent, nextOptions) =>
                (await extractExcel(embeddedContent, { depth: nextOptions.depth })).text,
        },
    });
}

function getWorksheetPartPaths(workbook: WorkBook): Map<string, string> {
    const workbookXml = getWorkbookFileText(workbook, "xl/workbook.xml");
    const relationshipsXml = getWorkbookFileText(workbook, "xl/_rels/workbook.xml.rels");
    if (!workbookXml || !relationshipsXml) {
        return new Map();
    }

    const relationshipTargets = new Map<string, string>();
    const relationshipsRoot = getDocumentRoot(parseXml(relationshipsXml));
    if (relationshipsRoot) {
        for (const relationship of childElements(relationshipsRoot)) {
            if (getLocalName(relationship) !== "Relationship") {
                continue;
            }

            const id = getAttribute(relationship, "Id");
            const target = getAttribute(relationship, "Target");
            const resolvedTarget = target ? resolveZipPath("xl", target) : null;
            if (id && resolvedTarget) {
                relationshipTargets.set(id, resolvedTarget);
            }
        }
    }

    const sheetPaths = new Map<string, string>();
    const workbookRoot = getDocumentRoot(parseXml(workbookXml));
    if (!workbookRoot) {
        return sheetPaths;
    }

    const sheetsNode = findFirstDescendant(workbookRoot, "sheets");
    if (!sheetsNode) {
        return sheetPaths;
    }

    for (const sheet of childElements(sheetsNode)) {
        if (getLocalName(sheet) !== "sheet") {
            continue;
        }

        const name = getAttribute(sheet, "name");
        const relationshipId = getAttribute(sheet, "r:id", "id");
        const target = relationshipId ? relationshipTargets.get(relationshipId) : null;
        if (name && target) {
            sheetPaths.set(name, target);
        }
    }

    return sheetPaths;
}

function getWorkbookFileText(workbook: WorkBook, path: string): string | null {
    const files = (workbook as { files?: Record<string, { content?: unknown }> }).files;
    const content = files?.[path]?.content;
    if (typeof content === "string") {
        return content;
    }

    if (content instanceof Uint8Array) {
        return Buffer.from(content).toString("utf8");
    }

    if (content instanceof ArrayBuffer) {
        return Buffer.from(content).toString("utf8");
    }

    return null;
}

function getWorkbookFileBinary(workbook: WorkBook, path: string): Uint8Array | null {
    const files = (workbook as { files?: Record<string, { content?: unknown }> }).files;
    const content = files?.[path]?.content;
    if (content instanceof Uint8Array) {
        return content;
    }

    if (content instanceof ArrayBuffer) {
        return new Uint8Array(content);
    }

    if (typeof content === "string") {
        return new Uint8Array(Buffer.from(content, "utf8"));
    }

    return null;
}

function getWorkbookRoot(workbook: WorkBook, path: string): ReturnType<typeof getDocumentRoot> {
    const xml = getWorkbookFileText(workbook, path);
    return xml ? getDocumentRoot(parseXml(xml)) : null;
}

function getWorkbookPartRelationships(workbook: WorkBook, partPath: string): Map<string, string> {
    const directory = partPath.split("/").slice(0, -1).join("/");
    const filename = partPath.split("/").at(-1);
    if (!filename) {
        return new Map();
    }

    const relationshipsPath = `${directory ? `${directory}/` : ""}_rels/${filename}.rels`;
    const relationshipsRoot = getWorkbookRoot(workbook, relationshipsPath);
    const targets = new Map<string, string>();
    if (!relationshipsRoot) {
        return targets;
    }

    for (const relationship of childElements(relationshipsRoot)) {
        if (getLocalName(relationship) !== "Relationship") {
            continue;
        }

        const id = getAttribute(relationship, "Id");
        const target = getAttribute(relationship, "Target");
        const resolved = target ? resolveZipPath(directory, target) : null;
        if (id && resolved) {
            targets.set(id, resolved);
        }
    }

    return targets;
}

function squashRelatedPartText(value: string): string {
    return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function isWorksheetCellAddress(value: string): boolean {
    return /^[A-Z]+[1-9]\d*$/i.test(value);
}

function hasVisibleComments(cell: unknown): cell is { c: Array<{ a?: string; t?: string }> } {
    return typeof cell === "object" && cell !== null && Array.isArray((cell as { c?: unknown }).c);
}

function compareCellAddresses(left: string, right: string): number {
    const leftAddress = utils.decode_cell(left);
    const rightAddress = utils.decode_cell(right);
    return leftAddress.r - rightAddress.r || leftAddress.c - rightAddress.c;
}

function normalizeAnnotationValue(value: unknown): string {
    const text = normalizeCellValue(value);
    return text === "undefined" || text === "null" ? "" : text;
}
