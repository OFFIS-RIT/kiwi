import { describe, expect, test } from "vitest";
import { getApproximateMinutes } from "./utils";

describe("getApproximateMinutes", () => {
    test("rounds milliseconds to approximate minutes", () => {
        expect(getApproximateMinutes(263_000)).toBe(4);
    });

    test("uses one minute as the lower bound", () => {
        expect(getApproximateMinutes(20_000)).toBe(1);
    });
});
