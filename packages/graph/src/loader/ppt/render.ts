import { squashWhitespace } from "../ooxml/xml";
import type { SlideContent } from "./types";

export function renderMarkdown(slides: SlideContent[]): string {
    const builder = new MarkdownBuilder();

    for (const slide of slides) {
        if (slide.blocks.length === 0) {
            continue;
        }

        if (!slide.hasTitle) {
            builder.append(`## Slide ${slide.index + 1}`);
        }

        for (const block of slide.blocks) {
            switch (block.kind) {
                case "heading":
                    builder.append(`# ${block.text}`);
                    break;
                case "paragraph":
                    builder.append(block.text);
                    break;
                case "bullet":
                    builder.append(`- ${block.text}`);
                    break;
                case "image":
                    builder.append(`:::IMG-${block.id}:::`);
                    break;
                case "table":
                    builder.append(rowsToMarkdown(block.rows));
                    break;
            }
        }
    }

    return builder.toString();
}

export function rowsToMarkdown(rows: string[][]): string {
    if (rows.length === 0) {
        return "";
    }

    const columnCount = getColumnCount(rows);
    if (columnCount <= 0) {
        return "";
    }

    const lines = [renderTableRow(rows[0] ?? [], columnCount), renderSeparatorRow(columnCount)];
    for (let index = 1; index < rows.length; index += 1) {
        lines.push(renderTableRow(rows[index] ?? [], columnCount));
    }

    return lines.join("\n");
}

class MarkdownBuilder {
    private readonly parts: string[] = [];

    append(value: string): void {
        const trimmed = value.trim();
        if (trimmed) {
            this.parts.push(trimmed);
        }
    }

    toString(): string {
        return this.parts.join("\n\n");
    }
}

function getColumnCount(rows: string[][]): number {
    let columnCount = 0;
    for (const row of rows) {
        columnCount = Math.max(columnCount, row.length);
    }

    return columnCount;
}

function renderSeparatorRow(columnCount: number): string {
    return `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;
}

function renderTableRow(row: string[], columnCount: number): string {
    const cells: string[] = [];
    for (let index = 0; index < columnCount; index += 1) {
        cells.push(escapeMarkdownTableCell(squashWhitespace(row[index] ?? "")));
    }

    return `| ${cells.join(" | ")} |`;
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}
