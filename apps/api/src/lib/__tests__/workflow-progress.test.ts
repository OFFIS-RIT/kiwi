import { describe, expect, mock, test } from "bun:test";

let capturedQuery: unknown;
const executeMock = mock(async (query: unknown) => {
    capturedQuery = query;
    return {
        rows: [
            {
                processRunId: "run-1",
                completedCount: 2,
                totalCount: 5,
            },
        ],
    };
});

mock.module("@kiwi/db", () => ({
    db: {
        execute: executeMock,
    },
}));

// Dynamic import is required so Bun applies the @kiwi/db mock before module evaluation.
const { findProcessDescriptionProgress } = await import("../workflow-progress");

function collectSqlText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (!value || typeof value !== "object") {
        return "";
    }

    if ("queryChunks" in value && Array.isArray(value.queryChunks)) {
        return value.queryChunks.map(collectSqlText).join("");
    }

    if ("value" in value && Array.isArray(value.value)) {
        return value.value.map(collectSqlText).join("");
    }

    return "";
}

describe("findProcessDescriptionProgress", () => {
    test("counts update-description grandchildren from description group workflows", async () => {
        const progress = await findProcessDescriptionProgress(["run-1"]);

        expect(progress.get("run-1")).toEqual({ done: 2, total: 5 });
        expect(collectSqlText(capturedQuery)).toContain("process-descriptions-groups");
        expect(collectSqlText(capturedQuery)).toContain("jsonb_array_length");
    });
});
