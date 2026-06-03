import { squashWhitespace } from "../ooxml/xml";
import type { SlideBlock } from "./types";

export function slideBlocksToPlainText(blocks: SlideBlock[]): string {
    const parts: string[] = [];
    for (const block of blocks) {
        switch (block.kind) {
            case "heading":
            case "paragraph":
            case "bullet":
                parts.push(block.text);
                break;
            case "table":
                parts.push(block.rows.map((row) => row.join(" | ")).join(" "));
                break;
            case "image":
                break;
        }
    }

    return squashWhitespace(parts.join(" "));
}
