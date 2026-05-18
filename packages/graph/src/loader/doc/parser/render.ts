import { squashWhitespace } from "../../ooxml/xml";
import type { DOCBlock } from "./types";
import { clampHeadingLevel, cleanInlineText } from "./text";

const IMAGE_FENCE_PATTERN = /^:::IMG-[^:]+:::$/;

export function renderMarkdown(blocks: DOCBlock[]): string {
    const builder = new MarkdownBuilder();

    for (const block of blocks) {
        switch (block.kind) {
            case "heading":
                builder.append(`${"#".repeat(clampHeadingLevel(block.level))} ${block.text}`);
                break;
            case "paragraph":
                builder.append(block.text);
                break;
            case "bullet": {
                const indent = "  ".repeat(Math.max(0, block.level));
                const marker = block.ordered ? "1." : "-";
                builder.append(`${indent}${marker} ${block.text}`);
                break;
            }
            case "table":
                builder.append(rowsToMarkdown(block.rows));
                break;
            case "image":
                builder.append(`:::IMG-${block.id}:::`);
                break;
        }
    }

    return cleanMarkdownText(builder.toString());
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
        if (value.trim()) {
            this.parts.push(value);
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
        cells.push(escapeMarkdownTableCell(cleanInlineText((row[index] ?? "").replace(/\s*\n\s*/g, " "))));
    }

    return `| ${cells.join(" | ")} |`;
}

function cleanMarkdownText(text: string): string {
    const lines = text
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => cleanMarkdownLine(line))
        .reduce<string[]>((acc, line) => {
            if (!line) {
                if (acc.at(-1) !== "") {
                    acc.push("");
                }

                return acc;
            }

            acc.push(line);
            return acc;
        }, []);

    while (lines.at(0) === "") {
        lines.shift();
    }

    while (lines.at(-1) === "") {
        lines.pop();
    }

    return lines.join("\n");
}

function cleanMarkdownLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) {
        return "";
    }

    if (IMAGE_FENCE_PATTERN.test(trimmed)) {
        return trimmed;
    }

    if (/^#+\s/.test(trimmed)) {
        const hashes = trimmed.match(/^#+/)?.[0] ?? "#";
        return `${hashes} ${squashWhitespace(trimmed.slice(hashes.length))}`;
    }

    const bulletMatch = line.match(/^(\s*)(- |\d+\. )(.*)$/);
    if (bulletMatch) {
        const indent = bulletMatch[1] ?? "";
        const marker = bulletMatch[2] ?? "-";
        const value = bulletMatch[3] ?? "";
        return `${indent}${marker.trim()} ${squashWhitespace(value)}`;
    }

    if (/^\|.*\|$/.test(trimmed)) {
        return trimmed;
    }

    return squashWhitespace(trimmed);
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}
