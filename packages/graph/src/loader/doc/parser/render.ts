import { Effect } from "effect";
import { squashWhitespace } from "../../ooxml/xml";
import type { DOCBlock } from "./types";
import { clampHeadingLevel, cleanInlineText } from "./text";

const IMAGE_FENCE_PATTERN = /^:::IMG-[^:]+:::$/;

export function renderMarkdown(blocks: DOCBlock[]): string {
    return Effect.runSync(renderMarkdownEffect(blocks));
}

export function renderMarkdownEffect(blocks: DOCBlock[]): Effect.Effect<string, unknown> {
    return Effect.try({
        try: () => renderMarkdownSync(blocks),
        catch: (error) => error,
    });
}

function renderMarkdownSync(blocks: DOCBlock[]): string {
    const rendered = blocks
        .map((block) => {
            switch (block.kind) {
                case "heading":
                    return `${"#".repeat(clampHeadingLevel(block.level))} ${block.text}`;
                case "paragraph":
                    return block.text;
                case "bullet": {
                    const indent = "  ".repeat(Math.max(0, block.level));
                    const marker = block.ordered ? "1." : "-";
                    return `${indent}${marker} ${block.text}`;
                }
                case "table":
                    return rowsToMarkdown(block.rows);
                case "image":
                    return `:::IMG-${block.id}:::`;
            }
        })
        .filter(Boolean);

    return cleanMarkdownText(rendered.join("\n\n"));
}

export function rowsToMarkdown(rows: string[][]): string {
    if (rows.length === 0) {
        return "";
    }

    const columnCount = Math.max(...rows.map((row) => row.length));
    if (!Number.isFinite(columnCount) || columnCount <= 0) {
        return "";
    }

    const normalizedRows = rows.map((row) => {
        const nextRow = row.map((cell) => escapeMarkdownTableCell(cleanInlineText(cell).replace(/\s*\n\s*/g, " ")));
        while (nextRow.length < columnCount) {
            nextRow.push("");
        }

        return nextRow;
    });

    const header = normalizedRows[0] ?? [];
    const separator = Array.from({ length: columnCount }, () => "---");
    const body = normalizedRows.slice(1);

    return [
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
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
