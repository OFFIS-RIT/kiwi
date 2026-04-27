import { describe, expect, test } from "vitest";
import { formatDuration } from "./utils";

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
