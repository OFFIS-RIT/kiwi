import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
const runApiTestEffect = <T, E>(effect: Effect.Effect<T, E, unknown>) =>
    Effect.runPromise(effect as Effect.Effect<T, E, never>);

const dbMock: Record<string, unknown> = {};
let cleanupUploadedKeysImpl: (keys: string[]) => Effect.Effect<unknown, unknown> = () => Effect.succeed([]);
const cleanupUploadedKeysMock = mock((keys: string[]) => cleanupUploadedKeysImpl(keys));

mock.module("@kiwi/db/effect", () => ({
    Database: Effect.succeed(dbMock),
    DatabaseError: class DatabaseError extends Error {},
    tryDb: (thunk: (db: typeof dbMock) => unknown) => {
        const result = thunk(dbMock);
        return Effect.isEffect(result) ? result : Effect.promise(async () => await result);
    },
    tryDbVoid: (thunk: (db: typeof dbMock) => unknown) => {
        const result = thunk(dbMock);
        return Effect.isEffect(result)
            ? Effect.asVoid(result)
            : Effect.asVoid(Effect.promise(async () => await result));
    },
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, unknown>) =>
        Effect.runPromise(effect as Effect.Effect<T, E, never>),
}));

mock.module("@kiwi/files", () => ({
    deleteFile: () => Effect.succeed(true),
    listFiles: () => Effect.succeed([]),
    putGraphFile: () => Effect.succeed({ key: "graphs/graph-1/file-1.txt", type: "text/plain" }),
}));

mock.module("@kiwi/logger", () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
}));

mock.module("@kiwi/worker/update-descriptions-spec", () => ({
    updateDescriptionsSpec: { name: "update-descriptions" },
}));

mock.module("../../env", () => ({
    env: {
        AUTH_SECRET: "test-auth-secret",
        S3_BUCKET: "test",
    },
}));

mock.module("../../workflow", () => ({
    wo: {
        runWorkflow: async () => ({ workflowRun: { id: "workflow-1" } }),
    },
}));

mock.module("@kiwi/ai", () => ({
    estimateToken: (value: string) => value.length,
    makeAiClient: () => Effect.succeed({ embedding: {} }),
}));

mock.module("@kiwi/ai/models", () => ({
    resolveRequiredEmbeddingModelAdapter: () => Effect.succeed({ adapter: {} }),
}));

mock.module("../chat-client", () => ({
    getRequiredResearchClient: () => ({ embedding: {} }),
}));

mock.module("../embed-text", () => ({
    embedText: () => Effect.succeed([0.1, 0.2, 0.3]),
}));

mock.module("../graph/route", () => ({
    cleanupUploadedKeys: cleanupUploadedKeysMock,
}));

mock.module("../graph/access", () => ({
    resolveGraphOwnerRoot: () => Effect.succeed({ mode: "organization", organizationId: "org-1" }),
}));

mock.module("../team/access", () => ({
    getActiveOrganizationId: () => Effect.succeed("org-1"),
    getOrganizationMembership: () => Effect.succeed({ organizationId: "org-1", role: "admin" }),
    getTeamInActiveOrganization: (_user: unknown, teamId: string) =>
        Effect.succeed({ id: teamId, name: "Team", organizationId: "org-1" }),
    getTeamRole: () => Effect.succeed("admin"),
    requireOrganizationAdmin: () => Effect.succeed({ organizationId: "org-1" }),
    requireOrganizationMembership: () => Effect.succeed(undefined),
    requireTeamAccess: () => Effect.succeed({ organizationAdmin: true, role: "admin" }),
    requireTeamGraphCreateAccess: () => Effect.succeed(undefined),
    requireTeamGraphFileManageAccess: () => Effect.succeed(undefined),
    requireTeamGraphManageAccess: () => Effect.succeed(undefined),
    requireTeamMemberManageAccess: () => Effect.succeed(undefined),
}));

const {
    applyGraphSuggestion,
    assertPendingGraphSuggestion,
    buildManualSuggestionContent,
    buildManualSuggestionRows,
    buildSourceCorrectionUpdate,
} = await import("../graph-suggestions");
const { API_ERROR_CODES } = await import("../../types");

mock.restore();

describe("graph suggestion apply helpers", () => {
    beforeEach(() => {
        for (const key of Object.keys(dbMock)) {
            delete dbMock[key];
        }

        cleanupUploadedKeysImpl = () => Effect.succeed([]);
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
                    limit: () => Effect.succeed(selectResults.shift() ?? []),
                }),
            }),
        }));
        dbMock.transaction = mock(() => Effect.fail(originalError));
        cleanupUploadedKeysImpl = () => Effect.fail(new Error("cleanup failed"));

        const user = { id: "admin-1" } as Parameters<typeof applyGraphSuggestion>[2];

        await expect(runApiTestEffect(applyGraphSuggestion("graph-1", "suggestion-1", user))).rejects.toBe(
            originalError
        );
        expect(cleanupUploadedKeysMock).toHaveBeenCalledWith(["graphs/graph-1/file-1.txt"]);
    });
});
