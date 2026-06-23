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

    test("spreads queued file work across worker concurrency slots", () => {
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
                workerConcurrency: 2,
            })
        ).toEqual({
            process_estimated_duration: 76667,
            process_time_remaining: 76667,
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
                workerConcurrency: 4,
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
