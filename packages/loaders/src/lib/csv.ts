export type CSVRow = {
    raw: string;
    fields: string[];
    startOffset: number;
    endOffset: number;
};

export class CSVParseError extends Error {
    constructor(message = "Invalid CSV content") {
        super(message);
        this.name = "CSVParseError";
    }
}

export function parseCSVRows(input: string): CSVRow[] {
    const rows: CSVRow[] = [];
    let rowStartOffset = 0;
    let fields: string[] = [];
    let field = "";
    let inQuotes = false;
    let quotedFieldClosed = false;

    const resetField = () => {
        field = "";
        quotedFieldClosed = false;
    };

    const pushField = () => {
        fields.push(field);
        resetField();
    };

    const pushRow = (endOffset: number) => {
        pushField();
        rows.push({
            raw: input.slice(rowStartOffset, endOffset),
            fields,
            startOffset: rowStartOffset,
            endOffset,
        });
        fields = [];
    };

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index]!;

        if (inQuotes) {
            if (char === '"') {
                const nextChar = input[index + 1];
                if (nextChar === '"') {
                    field += '"';
                    index += 1;
                    continue;
                }

                inQuotes = false;
                quotedFieldClosed = true;
                continue;
            }

            field += char;
            continue;
        }

        if (quotedFieldClosed && char !== "," && char !== "\n" && char !== "\r") {
            if (char.trim() === "") {
                continue;
            }

            throw new CSVParseError();
        }

        if (char === '"') {
            if (quotedFieldClosed || field.trim().length > 0) {
                throw new CSVParseError();
            }

            inQuotes = true;
            field = "";
            continue;
        }

        if (char === ",") {
            pushField();
            continue;
        }

        if (char === "\n" || char === "\r") {
            const lineBreakLength = char === "\r" && input[index + 1] === "\n" ? 2 : 1;
            pushRow(index);
            index += lineBreakLength - 1;
            rowStartOffset = index + 1;
            continue;
        }

        field += char;
    }

    if (inQuotes) {
        throw new CSVParseError();
    }

    if (rowStartOffset < input.length || field.length > 0 || fields.length > 0) {
        pushRow(input.length);
    }

    return rows.filter((row) => row.raw.trim() !== "" || row.fields.some((value) => value.trim() !== ""));
}
