import { cleanInlineText } from "./text";
import type { DOCBlock } from "./types";

export function blocksToPlainText(blocks: DOCBlock[]): string {
    const parts: string[] = [];

    for (const block of blocks) {
        switch (block.kind) {
            case "heading":
            case "paragraph":
            case "bullet":
                parts.push(block.text);
                break;
            case "table":
                for (const row of block.rows) {
                    parts.push(cleanInlineText(row.join(" ")));
                }
                break;
            case "pageBreak":
                if (parts.at(-1) !== "") {
                    parts.push("");
                }
                break;
            case "image":
                break;
        }
    }

    return cleanInlineText(parts.join("\n"));
}

export function textToParagraphBlocks(value: string): DOCBlock[] {
    const text = cleanInlineText(value);
    return text ? [{ kind: "paragraph", text }] : [];
}

export function looksLikeHeaderRow(rows: string[][]): boolean {
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
