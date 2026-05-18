import { Effect } from "effect";
import { squashWhitespace } from "../../ooxml/xml";
import type { SlideContent } from "./types";

export function renderMarkdown(slides: SlideContent[]): string {
    return Effect.runSync(renderMarkdownEffect(slides));
}

export function renderMarkdownEffect(slides: SlideContent[]): Effect.Effect<string, unknown> {
    return Effect.try({
        try: () => renderMarkdownSync(slides),
        catch: (error) => error,
    });
}

function renderMarkdownSync(slides: SlideContent[]): string {
    const rendered = slides
        .map((slide) => {
            if (slide.blocks.length === 0) {
                return "";
            }

            const blocks: string[] = [];
            if (!slide.hasTitle) {
                blocks.push(`## Slide ${slide.index + 1}`);
            }

            for (const block of slide.blocks) {
                switch (block.kind) {
                    case "heading":
                        blocks.push(`# ${block.text}`);
                        break;
                    case "paragraph":
                        blocks.push(block.text);
                        break;
                    case "bullet":
                        blocks.push(`- ${block.text}`);
                        break;
                    case "image":
                        blocks.push(`:::IMG-${block.id}:::`);
                        break;
                    case "table":
                        blocks.push(rowsToMarkdown(block.rows));
                        break;
                }
            }

            return blocks
                .map((block) => block.trim())
                .filter(Boolean)
                .join("\n\n");
        })
        .filter(Boolean);

    return rendered.join("\n\n");
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
        const nextRow = row.map((cell) => escapeMarkdownTableCell(squashWhitespace(cell)));
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

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}
