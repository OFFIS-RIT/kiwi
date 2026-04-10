import { describe, expect, test } from "bun:test";

import { buildMetadataExcerpt, normalizeMetadata } from "../metadata";

describe("buildMetadataExcerpt", () => {
    test("returns full text when document is short enough", () => {
        const text = Array.from({ length: 12 }, (_, index) => `word-${index + 1}`).join(" ");

        expect(buildMetadataExcerpt(text)).toBe(`<text>\n${text}\n</text>`);
    });

    test("returns first and last 250 words with omission marker for longer text", () => {
        const text = Array.from({ length: 700 }, (_, index) => `word-${index + 1}`).join(" ");
        const excerpt = buildMetadataExcerpt(text);

        expect(excerpt).toContain("<start>");
        expect(excerpt).toContain("</start>");
        expect(excerpt).toContain("[... middle of document omitted ...]");
        expect(excerpt).toContain("<end>");
        expect(excerpt).toContain("</end>");
        expect(excerpt).toContain("word-1");
        expect(excerpt).toContain("word-250");
        expect(excerpt).not.toContain("word-251");
        expect(excerpt).toContain("word-451");
        expect(excerpt).toContain("word-700");
    });

    test("returns undefined for empty text", () => {
        expect(buildMetadataExcerpt("   \n\t  ")).toBeUndefined();
    });
});

describe("normalizeMetadata", () => {
    test("collapses line breaks and repeated whitespace", () => {
        expect(normalizeMetadata("  First line\n\nSecond   line\tthird  ")).toBe("First line Second line third");
    });
});
