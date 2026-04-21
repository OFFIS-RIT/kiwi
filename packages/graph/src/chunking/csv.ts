import type { GraphChunker } from "..";
import { get_encoding } from "tiktoken";

type CSVChunkerOptions = {
    maxChunkSize: number;
    encoder?: string;
};

export class CSVChunker implements GraphChunker {
    private readonly maxChunkSize: number;
    private readonly encoderName: string;

    constructor(options: CSVChunkerOptions) {
        this.maxChunkSize = options.maxChunkSize;
        this.encoderName = options.encoder ?? "o200k_base";
    }

    async getChunks(input: string): Promise<string[]> {
        const text = input.trim();
        if (text === "") {
            return [];
        }

        const encoder = get_encoding(this.encoderName as Parameters<typeof get_encoding>[0]);

        try {
            const rows = text.split("\n");
            if (rows.length === 0) {
                return [];
            }

            const hasHeader = isCSVHeader(rows);
            if (rows.length === 1) {
                return [rows[0]!];
            }

            const headerRow = hasHeader ? rows[0]! : "";
            const dataRows = hasHeader ? rows.slice(1) : rows;
            const chunks: string[] = [];
            let currentRows: string[] = [];
            let currentTokens = 0;

            const flushChunk = () => {
                if (currentRows.length === 0) {
                    return;
                }

                const chunk = hasHeader ? `${headerRow}\n${currentRows.join("\n")}` : currentRows.join("\n");

                chunks.push(chunk);
                currentRows = [];
                currentTokens = 0;
            };

            for (const row of dataRows) {
                const rowTokens = encoder.encode(row).length + 1;

                if (currentTokens + rowTokens > this.maxChunkSize && currentRows.length > 0) {
                    flushChunk();
                }

                currentRows.push(row);
                currentTokens += rowTokens;
            }

            flushChunk();
            return chunks;
        } finally {
            encoder.free();
        }
    }
}

function isCSVHeader(rows: string[]): boolean {
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

function cleanFields(row: string): string[] {
    return row.split(",").map((field) => field.trim().replace(/^"|"$/g, ""));
}

function isNumeric(value: string): boolean {
    if (value === "") {
        return false;
    }

    return Number.isFinite(Number(value));
}
