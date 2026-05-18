import { Effect } from "effect";
import { read, utils, type WorkBook, type WorkSheet } from "xlsx";
import { rowsToMarkdown } from "./render";
import type { ExcelResult, ExcelSheetResult } from "./types";

export function extractExcel(content: ArrayBuffer): ExcelResult {
    return Effect.runSync(extractExcelEffect(content));
}

export function extractExcelEffect(content: ArrayBuffer): Effect.Effect<ExcelResult, unknown> {
    return Effect.gen(function* () {
        const workbook = yield* readWorkbookEffect(content);
        const sheets: ExcelSheetResult[] = [];

        for (const [index, sheetName] of workbook.SheetNames.entries()) {
            const sheet = yield* renderSheetEffect(workbook, sheetName, index);
            if (sheet) {
                sheets.push(sheet);
            }
        }

        return {
            text: sheets.map((sheet) => sheet.text).join("\n\n"),
            sheets,
        };
    });
}

function readWorkbookEffect(content: ArrayBuffer): Effect.Effect<WorkBook, unknown> {
    return Effect.try({
        try: () => {
            const bytes = new Uint8Array(content);
            if (!isLikelyWorkbook(bytes)) {
                throw new Error("Invalid Excel workbook content");
            }

            return read(bytes, {
                type: "array",
                cellText: true,
                cellDates: true,
                cellStyles: true,
            });
        },
        catch: (error) => error,
    });
}

function isLikelyWorkbook(bytes: Uint8Array): boolean {
    const isZipBasedWorkbook = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const isLegacyXLSWorkbook = bytes[0] === 0xd0 && bytes[1] === 0xcf;
    return isZipBasedWorkbook || isLegacyXLSWorkbook;
}

function renderSheetEffect(
    workbook: WorkBook,
    sheetName: string,
    index: number
): Effect.Effect<ExcelSheetResult | null, unknown> {
    return Effect.try({
        try: () => renderSheet(workbook, sheetName, index),
        catch: (error) => error,
    });
}

function renderSheet(workbook: WorkBook, sheetName: string, index: number): ExcelSheetResult | null {
    if (isHiddenSheet(workbook, index)) {
        return null;
    }

    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
        return null;
    }

    const trimmedRows = extractWorksheetRows(worksheet)
        .map(trimTrailingEmptyCells)
        .filter((row) => row.some((cell) => cell.length > 0));
    const colCount = Math.max(0, ...trimmedRows.map((row) => row.length));
    const normalizedRows =
        colCount === 0
            ? []
            : trimmedRows.map((row) => {
                  const nextRow = [...row];
                  while (nextRow.length < colCount) {
                      nextRow.push("");
                  }

                  return nextRow;
              });

    if (normalizedRows.length === 0) {
        return null;
    }

    const table = rowsToMarkdown(normalizedRows);
    const text = [`## Sheet: ${cleanSheetName(sheetName)}`, table].filter(Boolean).join("\n\n");

    return {
        name: sheetName,
        text,
        rowCount: normalizedRows.length,
        colCount,
    };
}

function isHiddenSheet(workbook: WorkBook, index: number): boolean {
    const sheet = workbook.Workbook?.Sheets?.[index];
    return sheet?.Hidden === 1 || sheet?.Hidden === 2;
}

function extractWorksheetRows(worksheet: WorkSheet): string[][] {
    const ref = worksheet["!ref"];
    if (!ref) {
        return [];
    }

    const range = utils.decode_range(ref);
    const hiddenRows = new Set((worksheet["!rows"] ?? []).flatMap((row, index) => (row?.hidden ? [index] : [])));
    const hiddenCols = new Set((worksheet["!cols"] ?? []).flatMap((col, index) => (col?.hidden ? [index] : [])));
    const rows: string[][] = [];

    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
        if (hiddenRows.has(rowIndex)) {
            continue;
        }

        const row: string[] = [];
        for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
            if (hiddenCols.has(colIndex)) {
                continue;
            }

            row.push(
                normalizeCellValue(getCellDisplayValue(worksheet[utils.encode_cell({ r: rowIndex, c: colIndex })]))
            );
        }

        rows.push(row);
    }

    return rows;
}

function getCellDisplayValue(cell: unknown): unknown {
    if (typeof cell !== "object" || cell === null) {
        return "";
    }

    const value = cell as { w?: unknown; v?: unknown };
    return typeof value.w === "string" ? value.w : value.v;
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
