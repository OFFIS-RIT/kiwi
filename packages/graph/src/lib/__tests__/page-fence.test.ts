import { describe, expect, test } from "bun:test";
import { renderPageFence, stripPageFences, toPageAwareChunks } from "../page-fence.ts";

describe("page fences", () => {
    test("renders and strips page fences", () => {
        expect(renderPageFence(3)).toBe(":::PAGE-3:::");
        expect(stripPageFences(":::PAGE-1:::\n\nAlpha\n\n:::PAGE-2:::\n\nBeta")).toBe("Alpha\n\nBeta");
    });

    test("derives single-page and multi-page spans while removing fences", () => {
        const chunks = toPageAwareChunks([
            ":::PAGE-1:::\n\nAlpha",
            "Beta before split.\n\n:::PAGE-2:::\n\nGamma after split.",
            "Delta same page.",
        ]);

        expect(chunks).toEqual([
            {
                content: "Alpha",
                startPage: 1,
                endPage: 1,
            },
            {
                content: "Beta before split.\n\nGamma after split.",
                startPage: 1,
                endPage: 2,
            },
            {
                content: "Delta same page.",
                startPage: 2,
                endPage: 2,
            },
        ]);
    });

    test("drops fence-only chunks and applies the page to following content", () => {
        expect(toPageAwareChunks([":::PAGE-4:::", "Alpha"])).toEqual([
            {
                content: "Alpha",
                startPage: 4,
                endPage: 4,
            },
        ]);
    });

    test("keeps chunks before the first page fence unpaged", () => {
        expect(toPageAwareChunks(["Preface"])).toEqual([
            {
                content: "Preface",
                startPage: null,
                endPage: null,
            },
        ]);
    });
});
