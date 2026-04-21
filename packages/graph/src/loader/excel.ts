import { read, utils, type WorkBook } from "xlsx";
import type { GraphBinaryLoader, GraphLoader } from "..";

type ExcelSheetResult = {
    name: string;
    text: string;
    rowCount: number;
    colCount: number;
};

type ExcelResult = {
    text: string;
    sheets: ExcelSheetResult[];
};

export class ExcelLoader implements GraphLoader {
    readonly filetype = "xlsx";

    constructor(private options: { loader: GraphBinaryLoader }) {}

    async getText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        const data = extractExcel(content);
        return data.text;
    }
}

function extractExcel(content: ArrayBuffer): ExcelResult {
    const workbook = read(new Uint8Array(content), {
        type: "array",
        cellText: true,
        cellDates: true,
    });

    const sheets = workbook.SheetNames.map((sheetName, index) => renderSheet(workbook, sheetName, index)).filter(
        (sheet): sheet is ExcelSheetResult => sheet !== null
    );

    return {
        text: sheets.map((sheet) => sheet.text).join("\n\n"),
        sheets,
    };
}

function renderSheet(workbook: WorkBook, sheetName: string, index: number): ExcelSheetResult | null {
    if (isHiddenSheet(workbook, index)) {
        return null;
    }

    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
        return null;
    }

    const rows = utils.sheet_to_json(worksheet, {
        header: 1,
        raw: false,
        defval: "",
        blankrows: false,
        skipHidden: true,
    }) as unknown[][];

    const stringRows = rows.map((row) =>
        row.map((cell) => {
            if (cell === null || cell === undefined) {
                return "";
            }

            if (cell instanceof Date) {
                return cell.toISOString();
            }

            return String(cell).replace(/\r/g, "").replace(/\s+/g, " ").trim();
        })
    );
    const trimmedRows = stringRows.map(trimTrailingEmptyCells).filter((row) => row.some((cell) => cell.length > 0));
    const colCount = Math.max(0, ...trimmedRows.map((row) => row.length));
    const normalized = {
        rows:
            colCount === 0
                ? []
                : trimmedRows.map((row) => {
                      const nextRow = [...row];
                      while (nextRow.length < colCount) {
                          nextRow.push("");
                      }

                      return nextRow;
                  }),
        colCount,
    };

    if (normalized.rows.length === 0) {
        return null;
    }

    const table = rowsToMarkdown(normalized.rows);
    const text = [`## Sheet: ${sheetName}`, table].filter(Boolean).join("\n\n");

    return {
        name: sheetName,
        text,
        rowCount: normalized.rows.length,
        colCount: normalized.colCount,
    };
}

function isHiddenSheet(workbook: WorkBook, index: number): boolean {
    const sheet = workbook.Workbook?.Sheets?.[index];
    return sheet?.Hidden === 1 || sheet?.Hidden === 2;
}

function trimTrailingEmptyCells(row: string[]): string[] {
    const nextRow = [...row];
    while (nextRow.length > 0 && nextRow[nextRow.length - 1] === "") {
        nextRow.pop();
    }

    return nextRow;
}

function rowsToMarkdown(rows: string[][]): string {
    if (rows.length === 0) {
        return "";
    }

    const header = rows[0] ?? [];
    const separator = Array.from({ length: header.length }, () => "---");
    const body = rows.slice(1);

    return [markdownRow(header), markdownRow(separator), ...body.map((row) => markdownRow(row))].join("\n");
}

function markdownRow(row: string[]): string {
    return `| ${row.map(escapeMarkdownTableCell).join(" | ")} |`;
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}
