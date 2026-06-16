import type { GraphChunker, GraphTextChunk } from "../types";
import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";
import { parseCSVRows, type CSVRow } from "../lib/csv";

type CSVChunkerOptions = {
    maxChunkSize: number;
};

export class CSVChunker implements GraphChunker {
    private readonly maxChunkSize: number;

    constructor(options: CSVChunkerOptions) {
        this.maxChunkSize = options.maxChunkSize;
    }

    async getChunks(input: string): Promise<string[]> {
        return (await this.getChunkSpans(input)).map((chunk) => chunk.content);
    }

    async getChunkSpans(input: string): Promise<GraphTextChunk[]> {
        return this.getChunkContents(input);
    }

    private async getChunkContents(input: string): Promise<GraphTextChunk[]> {
        const { text, offset } = trimCSVInput(input);
        if (text === "") {
            return [];
        }

        const encoder = new Tiktoken(o200k_base);
        const tokenCount = (value: string) => encoder.encode(value).length;
        const rows = parseCSVRows(text).map((row) => ({
            ...row,
            startOffset: row.startOffset + offset,
            endOffset: row.endOffset + offset,
        }));

        if (rows.length === 0) {
            return [];
        }

        const hasHeader = isCSVHeader(rows);
        if (rows.length === 1) {
            const row = rows[0]!;
            return [{ content: row.raw, startOffset: row.startOffset, endOffset: row.endOffset }];
        }

        const headerRow = hasHeader ? rows[0]! : null;
        const dataRows = hasHeader ? rows.slice(1) : rows;
        const chunks: GraphTextChunk[] = [];
        let currentRows: CSVRow[] = [];

        const flushChunk = () => {
            if (currentRows.length === 0) {
                return;
            }

            const content = renderCSVChunk(headerRow, currentRows);
            const firstRow = currentRows[0]!;
            const lastRow = currentRows[currentRows.length - 1]!;

            chunks.push({
                content,
                startOffset: chunks.length === 0 && headerRow ? headerRow.startOffset : firstRow.startOffset,
                endOffset: lastRow.endOffset,
            });
            currentRows = [];
        };

        for (const row of dataRows) {
            const candidate = renderCSVChunk(headerRow, [...currentRows, row]);

            if (this.maxChunkSize > 0 && currentRows.length > 0 && tokenCount(candidate) > this.maxChunkSize) {
                flushChunk();
            }

            currentRows.push(row);
        }

        flushChunk();
        return chunks;
    }
}

function renderCSVChunk(headerRow: CSVRow | null, rows: CSVRow[]): string {
    const rowText = rows.map((row) => row.raw);
    return headerRow ? [headerRow.raw, ...rowText].join("\n") : rowText.join("\n");
}

function trimCSVInput(input: string): { text: string; offset: number } {
    let start = 0;
    let end = input.length;

    while (start < end && /\s/u.test(input[start]!)) {
        start += 1;
    }

    while (end > start && /\s/u.test(input[end - 1]!)) {
        end -= 1;
    }

    return {
        text: input.slice(start, end),
        offset: start,
    };
}

function isCSVHeader(rows: CSVRow[]): boolean {
    if (rows.length < 2) {
        return false;
    }

    const firstFields = cleanFields(rows[0]!);
    const columnCount = firstFields.length;
    if (columnCount === 0) {
        return false;
    }

    const sampleSize = Math.min(5, rows.length - 1);
    const firstRowNumeric = firstFields.filter(isNumeric).length;

    const columnNumeric = Array.from({ length: columnCount }, () => 0);
    let dataNumericTotal = 0;
    let dataFieldTotal = 0;

    for (let rowIndex = 1; rowIndex <= sampleSize; rowIndex += 1) {
        const fields = cleanFields(rows[rowIndex]!);
        for (let columnIndex = 0; columnIndex < Math.min(columnCount, fields.length); columnIndex += 1) {
            dataFieldTotal += 1;
            if (isNumeric(fields[columnIndex]!)) {
                columnNumeric[columnIndex] = (columnNumeric[columnIndex] ?? 0) + 1;
                dataNumericTotal += 1;
            }
        }
    }

    if (firstRowNumeric === 0 && dataNumericTotal > 0) {
        return true;
    }

    const firstRowNumericRatio = firstRowNumeric / columnCount;
    const dataNumericRatio = dataFieldTotal > 0 ? dataNumericTotal / dataFieldTotal : 0;
    if (firstRowNumericRatio < 0.3 && dataNumericRatio > firstRowNumericRatio + 0.2) {
        return true;
    }

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        if (columnNumeric[columnIndex]! === sampleSize && !isNumeric(firstFields[columnIndex]!)) {
            return true;
        }
    }

    if (firstRowNumeric === 0 && columnCount > 1) {
        let matchesInData = 0;
        let nonEmpty = 0;

        for (let columnIndex = 0; columnIndex < firstFields.length; columnIndex += 1) {
            const headerValue = firstFields[columnIndex];
            if (headerValue === undefined || headerValue === "") {
                continue;
            }

            nonEmpty += 1;
            for (let rowIndex = 1; rowIndex <= sampleSize; rowIndex += 1) {
                const fields = cleanFields(rows[rowIndex]!);
                const field = fields[columnIndex];
                if (
                    field !== undefined &&
                    field.localeCompare(headerValue, undefined, {
                        sensitivity: "accent",
                    }) === 0
                ) {
                    matchesInData += 1;
                    break;
                }
            }
        }

        if (nonEmpty > 0 && matchesInData === 0) {
            return true;
        }
    }

    return false;
}

function cleanFields(row: CSVRow): string[] {
    return row.fields.map((field) => field.trim());
}

function isNumeric(value: string): boolean {
    if (value === "") {
        return false;
    }

    return Number.isFinite(Number(value));
}
