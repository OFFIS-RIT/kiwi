import { describe, expect, mock, test } from "bun:test";

mock.module("@kiwi/ai", () => ({
    estimateToken: (text: string) => text.length,
    withAiSlot: async (_capability: string, run: () => Promise<unknown>) => run(),
}));

mock.module("@kiwi/db", () => ({
    db: {},
}));

mock.module("@kiwi/files", () => ({
    putGraphFile: async () => ({ key: "graphs/graph-1/file-1.txt", type: "text/plain" }),
}));

mock.module("@kiwi/logger", () => ({
    error: () => undefined,
}));

mock.module("@kiwi/worker/update-descriptions-spec", () => ({
    updateDescriptionsSpec: { name: "update-descriptions" },
}));

mock.module("../../env", () => ({
    env: {
        S3_BUCKET: "test",
    },
}));

mock.module("../../openworkflow", () => ({
    ow: {
        runWorkflow: async () => ({ workflowRun: { id: "workflow-1" } }),
    },
}));

mock.module("../chat", () => ({
    getRequiredResearchClient: () => ({ embedding: {} }),
}));

mock.module("../graph-route", () => ({
    cleanupUploadedKeys: async () => [],
}));

const {
    assertPendingGraphSuggestion,
    buildManualSuggestionContent,
    buildManualSuggestionRows,
    buildSourceCorrectionUpdate,
} = await import("../graph-suggestions");
const { API_ERROR_CODES } = await import("../../types");

describe("graph suggestion apply helpers", () => {
    test("builds source correction update values", () => {
        const embedding = [0.1, 0.2, 0.3];

        expect(buildSourceCorrectionUpdate({ suggestion: "The deadline is Tuesday." }, embedding)).toEqual({
            description: "The deadline is Tuesday.",
            embedding,
            active: true,
        });
    });

    test("builds manual source rows for entity additions", () => {
        const rows = buildManualSuggestionRows({
            graphId: "graph-1",
            suggestion: {
                id: "suggestion-1",
                entityId: "entity-1",
                reference: "Missing deadline",
                suggestion: "The deadline is Tuesday.",
            },
            fileId: "file-1",
            textUnitId: "unit-1",
            sourceId: "source-1",
            fileName: "manual-suggestion-suggestion-1.txt",
            fileKey: "graphs/graph-1/file-1.txt",
            fileSize: 64,
            embedding: [0.1, 0.2, 0.3],
        });

        expect(rows.file).toMatchObject({
            id: "file-1",
            graphId: "graph-1",
            name: "manual-suggestion-suggestion-1.txt",
            size: 64,
            type: "text",
            mimeType: "text/plain",
            key: "graphs/graph-1/file-1.txt",
            status: "processed",
            processStep: "completed",
            metadata: JSON.stringify({ source: "manual_suggestion", suggestionId: "suggestion-1" }),
        });
        expect(rows.textUnit).toEqual({
            id: "unit-1",
            fileId: "file-1",
            text: buildManualSuggestionContent({
                reference: "Missing deadline",
                suggestion: "The deadline is Tuesday.",
            }),
        });
        expect(rows.source).toEqual({
            id: "source-1",
            entityId: "entity-1",
            relationshipId: null,
            textUnitId: "unit-1",
            active: true,
            description: "The deadline is Tuesday.",
            sourceChunkIds: [],
            embedding: [0.1, 0.2, 0.3],
        });
    });

    test("rejects already-applied suggestions", () => {
        expect(() => assertPendingGraphSuggestion({ status: "applied" })).toThrow(API_ERROR_CODES.INVALID_SUGGESTION);
    });

    test("rejects missing suggestions", () => {
        expect(() => assertPendingGraphSuggestion(undefined)).toThrow(API_ERROR_CODES.SUGGESTION_NOT_FOUND);
    });
});
