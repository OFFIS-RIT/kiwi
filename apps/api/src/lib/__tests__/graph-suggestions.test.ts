import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("ai", () => ({
    embed: async () => ({ embedding: [0.1, 0.2, 0.3] }),
}));

const dbMock: Record<string, unknown> = {};
let cleanupUploadedKeysImpl: (keys: string[]) => Promise<unknown> = async () => [];
const cleanupUploadedKeysMock = mock((keys: string[]) => cleanupUploadedKeysImpl(keys));

mock.module("@kiwi/db", () => ({
    db: dbMock,
}));

mock.module("@kiwi/files", () => ({
    deleteFile: async () => undefined,
    listFiles: async () => [],
    putGraphFile: async () => ({ key: "graphs/graph-1/file-1.txt", type: "text/plain" }),
}));

mock.module("@kiwi/logger", () => ({
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
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

mock.module("../chat-client", () => ({
    getRequiredResearchClient: () => ({ embedding: {} }),
}));

mock.module("../graph-route", () => ({
    cleanupUploadedKeys: cleanupUploadedKeysMock,
}));

const {
    applyGraphSuggestion,
    assertPendingGraphSuggestion,
    buildManualSuggestionContent,
    buildManualSuggestionRows,
    buildSourceCorrectionUpdate,
} = await import("../graph-suggestions");
const { API_ERROR_CODES } = await import("../../types");

describe("graph suggestion apply helpers", () => {
    beforeEach(() => {
        for (const key of Object.keys(dbMock)) {
            delete dbMock[key];
        }

        cleanupUploadedKeysImpl = async () => [];
        cleanupUploadedKeysMock.mockClear();
    });

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

    test("preserves the original apply error when upload cleanup fails", async () => {
        const originalError = new Error(API_ERROR_CODES.INVALID_SUGGESTION);
        const pendingEntitySuggestion = {
            id: "suggestion-1",
            graphId: "graph-1",
            kind: "entity_addition" as const,
            status: "pending" as const,
            sourceId: null,
            entityId: "entity-1",
            reference: "Missing deadline",
            suggestion: "The deadline is Tuesday.",
            suggestedByUserId: "user-1",
            chatId: "chat-1",
            messageId: "message-1",
            appliedByUserId: null,
            appliedSourceId: null,
            appliedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        const selectResults = [[pendingEntitySuggestion], [{ id: "entity-1" }], [pendingEntitySuggestion]];

        dbMock.select = mock(() => ({
            from: () => ({
                where: () => ({
                    limit: async () => selectResults.shift() ?? [],
                }),
            }),
        }));
        dbMock.transaction = mock(async () => {
            throw originalError;
        });
        cleanupUploadedKeysImpl = async () => {
            throw new Error("cleanup failed");
        };

        await expect(applyGraphSuggestion("graph-1", "suggestion-1", "admin-1")).rejects.toBe(originalError);
        expect(cleanupUploadedKeysMock).toHaveBeenCalledWith(["graphs/graph-1/file-1.txt"]);
    });
});
