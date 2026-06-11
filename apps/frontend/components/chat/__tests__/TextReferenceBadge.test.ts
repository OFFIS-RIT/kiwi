import { describe, expect, it } from "vitest";
import { mergeHighlightRectangles } from "../TextReferenceBadge";

describe("mergeHighlightRectangles", () => {
    it("keeps disjoint rectangles separate", () => {
        const merged = mergeHighlightRectangles([
            { left: 0.1, top: 0.1, width: 0.1, height: 0.1 },
            { left: 0.6, top: 0.6, width: 0.1, height: 0.1 },
        ]);

        expect(merged).toHaveLength(2);
    });

    it("merges overlapping line rectangles into one block", () => {
        const merged = mergeHighlightRectangles([
            { left: 0.1, top: 0.1, width: 0.4, height: 0.02 },
            { left: 0.1, top: 0.115, width: 0.38, height: 0.02 },
        ]);

        expect(merged).toEqual([{ left: 0.1, top: 0.1, width: 0.4, height: 0.035 }]);
    });

    it("merges nearly touching line rectangles within tolerance", () => {
        const merged = mergeHighlightRectangles([
            { left: 0.1, top: 0.1, width: 0.4, height: 0.02 },
            { left: 0.1, top: 0.123, width: 0.4, height: 0.02 },
        ]);

        expect(merged).toHaveLength(1);
    });

    it("does not merge rectangles in separate columns", () => {
        const merged = mergeHighlightRectangles([
            { left: 0.05, top: 0.1, width: 0.4, height: 0.02 },
            { left: 0.55, top: 0.1, width: 0.4, height: 0.02 },
        ]);

        expect(merged).toHaveLength(2);
    });

    it("merges transitively across a chain of rectangles", () => {
        const merged = mergeHighlightRectangles([
            { left: 0.1, top: 0.1, width: 0.4, height: 0.02 },
            { left: 0.1, top: 0.14, width: 0.4, height: 0.02 },
            { left: 0.1, top: 0.12, width: 0.4, height: 0.02 },
        ]);

        expect(merged).toEqual([{ left: 0.1, top: 0.1, width: 0.4, height: 0.06 }]);
    });

    it("clamps out-of-range values before merging", () => {
        const merged = mergeHighlightRectangles([{ left: -0.2, top: 0.5, width: 1.5, height: Number.NaN }]);

        expect(merged).toEqual([{ left: 0, top: 0.5, width: 1, height: 0 }]);
    });
});
