import { squashWhitespace } from "../ooxml/xml";
import { renderPageFence } from "../../lib/page-fence";
import type { SlideContent } from "./types";

export function renderMarkdown(slides: SlideContent[]): string {
    const builder = new MarkdownBuilder();

    for (const slide of slides) {
        if (slide.blocks.length === 0) {
            continue;
        }

        builder.append(renderPageFence(slide.index + 1));

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
                    builder.append(
                        `${"  ".repeat(Math.max(0, block.level))}${block.ordered ? "1." : "-"} ${block.text}`
                    );
                    break;
                case "image":
                    builder.append(`:::IMG-${block.id}:::`);
                    break;
                case "table":
                    builder.append(rowsToMarkdown(block.rows, { hasHeader: block.hasHeader }));
                    break;
            }
        }
    }

    return builder.toString();
}

export function rowsToMarkdown(rows: string[][], options: { hasHeader?: boolean } = {}): string {
    if (rows.length === 0) {
        return "";
    }

    const columnCount = getColumnCount(rows);
    if (columnCount <= 0) {
        return "";
    }

    const hasHeader = options.hasHeader ?? true;
    const headerRow = hasHeader ? (rows[0] ?? []) : [];
    const bodyStart = hasHeader ? 1 : 0;
    const lines = [renderTableRow(headerRow, columnCount), renderSeparatorRow(columnCount)];
    for (let index = bodyStart; index < rows.length; index += 1) {
        lines.push(renderTableRow(rows[index] ?? [], columnCount));
    }

    return lines.join("\n");
}

class MarkdownBuilder {
    private readonly parts: string[] = [];

    append(value: string): void {
        if (value.trim()) {
            this.parts.push(value.trimEnd());
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
