import { describe, expect, test } from "vitest";
import { formatDuration, getSafeRedirectPath } from "./utils";

describe("getSafeRedirectPath", () => {
    test("allows local absolute paths", () => {
        expect(getSafeRedirectPath("/projects?id=1")).toBe("/projects?id=1");
    });

    test("rejects protocol-relative and backslash paths", () => {
        expect(getSafeRedirectPath("//evil.com")).toBe("/");
        expect(getSafeRedirectPath("/\\evil.com")).toBe("/");
    });

    test("rejects full external URLs", () => {
        expect(getSafeRedirectPath("https://evil.com")).toBe("/");
    });
});

describe("formatDuration", () => {
    test("returns whole duration parts", () => {
        expect(formatDuration(263_000)).toEqual({
            days: 0,
            hours: 0,
            minutes: 4,
            seconds: 23,
        });
    });

    test("returns days and hours for long durations", () => {
        expect(formatDuration(49 * 60 * 60_000)).toEqual({
            days: 2,
            hours: 1,
            minutes: 0,
            seconds: 0,
        });
    });
});
