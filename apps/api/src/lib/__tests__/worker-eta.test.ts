import { describe, expect, test } from "bun:test";
import { estimateProcessRunEta } from "../worker-eta";

describe("estimateProcessRunEta", () => {
    test("returns a default estimate before a pending run starts", () => {
        expect(
            estimateProcessRunEta({
                status: "pending",
                files: [{ type: "text", size: 500_000, state: "waiting" }],
                bucketAverages: new Map(),
                typeAverages: new Map(),
            })
        ).toEqual({
            process_estimated_duration: 38334,
            process_time_remaining: 38334,
        });
    });

    test("sums queued file work for the single-job worker", () => {
        expect(
            estimateProcessRunEta({
                status: "pending",
                files: [
                    { type: "text", size: 500_000, state: "waiting" },
                    { type: "text", size: 500_000, state: "waiting" },
                    { type: "text", size: 500_000, state: "waiting" },
                    { type: "text", size: 500_000, state: "waiting" },
                ],
                bucketAverages: new Map(),
                typeAverages: new Map(),
            })
        ).toEqual({
            process_estimated_duration: 153334,
            process_time_remaining: 153334,
        });
    });

    test("keeps one active file bound by its own remaining work", () => {
        expect(
            estimateProcessRunEta({
                status: "started",
                startedAt: new Date("2026-01-01T00:00:00.000Z"),
                now: new Date("2026-01-01T00:00:10.000Z"),
                files: [{ type: "text", size: 500_000, state: "active" }],
                bucketAverages: new Map(),
                typeAverages: new Map(),
            })
        ).toEqual({
            process_estimated_duration: 38334,
            process_time_remaining: 26834,
        });
    });

    test("blends mature bucket history with default estimates", () => {
        expect(
            estimateProcessRunEta({
                status: "pending",
                files: [{ type: "text", size: 500_000, state: "waiting" }],
                bucketAverages: new Map([["text:small", { duration: 120_000, samples: 3 }]]),
                typeAverages: new Map(),
            })
        ).toEqual({
            process_estimated_duration: 107334,
            process_time_remaining: 107334,
        });
    });
});
