import { describe, expect, test } from "bun:test";
import { createPositionedRegion, orderPositionedRegions, verticalRegionsOverlap } from "../layout";
import type { BoundingBox } from "../types";

function region(text: string, bbox: BoundingBox) {
    return createPositionedRegion({ text }, bbox);
}

describe("PDF reading layout", () => {
    test("does not count separated vertical bands as overlapping", () => {
        const top = region("Top", { x: 100, y: 700, width: 100, height: 10 });
        const near = region("Near", { x: 100, y: 690, width: 100, height: 8 });
        const far = region("Far", { x: 100, y: 650, width: 100, height: 10 });

        expect(verticalRegionsOverlap(top, near, 3)).toBe(true);
        expect(verticalRegionsOverlap(top, far, 3)).toBe(false);
    });

    test("keeps side regions that vertically overlap spanning rows", () => {
        const left = region("Form W-4", { x: 36, y: 733, width: 60, height: 29 });
        const span = region("Employee's Withholding Certificate", { x: 196, y: 743, width: 373, height: 16 });
        const right = region("OMB No. 1545-0074", { x: 480, y: 744, width: 80, height: 10 });

        const ordered = orderPositionedRegions([span, left, right], 612, 0).map((entry) => entry.value.text);

        expect(ordered).toEqual(["Form W-4", "Employee's Withholding Certificate", "OMB No. 1545-0074"]);
    });
});
