import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";

let dbRows: Array<{ id: string }> = [];
const capturedQueries: unknown[] = [];

const executeMock = mock((query: unknown) => {
    capturedQueries.push(query);
    return Effect.succeed(dbRows);
});

const dbMock = {
    execute: executeMock,
};

const cancelWorkflowRunMock = mock(async (_workflowRunId: string) => undefined);

mock.module("@kiwi/db/effect", () => ({
    Database: Effect.succeed(dbMock),
    DatabaseError: class DatabaseError extends Error {},
    tryDb: (thunk: (db: typeof dbMock) => unknown) => {
        const result = thunk(dbMock);
        return Effect.isEffect(result) ? result : Effect.promise(async () => await result);
    },
}));

mock.module("@kiwi/logger", () => ({
    error: () => undefined,
}));

mock.module("../../workflow", () => ({
    wo: {
        cancelWorkflowRun: cancelWorkflowRunMock,
    },
}));

// Dynamic import is required so Bun applies the @kiwi/db/effect and workflow mocks before module evaluation.
const { FILE_PROCESSING_WORKFLOW_NAMES, cancelActiveFileProcessingWorkflowRuns } = await import("../workflow-cancellation");

function collectStrings(value: unknown, seen = new WeakSet<object>()): string[] {
    if (typeof value === "string") {
        return [value];
    }

    if (!value || typeof value !== "object") {
        return [];
    }

    if (seen.has(value)) {
        return [];
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.flatMap((item) => collectStrings(item, seen));
    }

    return Object.values(value).flatMap((item) => collectStrings(item, seen));
}

describe("workflow cancellation", () => {
    beforeEach(() => {
        dbRows = [];
        capturedQueries.length = 0;
        executeMock.mockClear();
        cancelWorkflowRunMock.mockClear();
    });

    test("targets both file-processing workflow names", () => {
        expect([...FILE_PROCESSING_WORKFLOW_NAMES]).toEqual(["process-file", "process-code-file"]);
    });

    test("queries active file-processing runs for both workflow names and skips workflow cancellation when none are active", async () => {
        const summary = await Effect.runPromise(
            cancelActiveFileProcessingWorkflowRuns("graph-1", ["file-1"]) as Effect.Effect<
                { requestedCount: number; canceledCount: number; skippedCount: number },
                never,
                never
            >
        );

        expect(summary).toEqual({ requestedCount: 0, canceledCount: 0, skippedCount: 0 });
        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(cancelWorkflowRunMock).not.toHaveBeenCalled();

        const queryStrings = collectStrings(capturedQueries[0]);
        expect(queryStrings).toContain("process-file");
        expect(queryStrings).toContain("process-code-file");
        expect(queryStrings).toContain("graph-1");
        expect(queryStrings).toContain("file-1");
    });

    test("returns a zero summary for an empty file set without querying workflow runs", async () => {
        const summary = await Effect.runPromise(
            cancelActiveFileProcessingWorkflowRuns("graph-1", []) as Effect.Effect<
                { requestedCount: number; canceledCount: number; skippedCount: number },
                never,
                never
            >
        );

        expect(summary).toEqual({ requestedCount: 0, canceledCount: 0, skippedCount: 0 });
        expect(executeMock).not.toHaveBeenCalled();
        expect(cancelWorkflowRunMock).not.toHaveBeenCalled();
    });
});
