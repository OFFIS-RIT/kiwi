import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import { API_ERROR_CODES } from "@kiwi/contracts/responses";

const runWorkerTestEffect = <T, E>(effect: Effect.Effect<T, E, unknown>) =>
    Effect.runPromise(effect as Effect.Effect<T, E, never>);

let queuedSelectRows: unknown[][] = [];
const selectMock = mock(() => ({
    from: () => ({
        where: () => ({
            limit: () => Effect.succeed(queuedSelectRows.shift() ?? []),
        }),
    }),
}));

mock.module("@kiwi/db/effect", () => ({
    Database: Effect.succeed({
        select: selectMock,
    }),
    DatabaseError: class DatabaseError extends Error {},
    runDatabaseEffect: <T, E>(effect: Effect.Effect<T, E, unknown>) =>
        Effect.runPromise(effect as Effect.Effect<T, E, never>),
}));

mock.module("../../env", () => ({
    env: {
        AUTH_SECRET: "test-auth-secret",
    },
}));

const { createWorkerClient } = await import("../ai");

const encryptedModelCredentials = "v1:G183hwnvbORsT9EW:kHjjs9mrWpOCxQQ1AODT1w:EVGQ3pTv5NW_68o_oii3Z4EQLD3KOQ";

function modelRow(type: "extract" | "embedding", modelId: string, providerModel: string) {
    return {
        id: `${type}-${modelId}`,
        organizationId: "organization-1",
        modelId,
        displayName: modelId,
        type,
        adapter: "openai",
        providerModel,
        encryptedCredentials: encryptedModelCredentials,
        isDefault: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
}

function queueWorkerModelRows(options: { includeTextModel: boolean }) {
    queuedSelectRows = [
        [{ id: "graph-1", organizationId: "organization-1", teamId: null, userId: null, graphId: null }],
        options.includeTextModel ? [modelRow("extract", "extract-default", "gpt-extract")] : [],
        [],
        [modelRow("embedding", "embedding-default", "text-embedding-3-small")],
        [],
        [],
        [],
    ];
}

describe("createWorkerClient", () => {
    beforeEach(() => {
        queuedSelectRows = [];
        selectMock.mockClear();
    });

    test("resolves the graph organization and builds a required worker client", async () => {
        queueWorkerModelRows({ includeTextModel: true });

        const client = await runWorkerTestEffect(createWorkerClient("graph-1"));

        expect(client.text.provider.startsWith("openai.")).toBe(true);
        expect(client.embedding.provider).toBe("openai.embedding");
        expect(selectMock).toHaveBeenCalledTimes(7);
    });

    test("fails when required worker models are missing", async () => {
        queueWorkerModelRows({ includeTextModel: false });

        await expect(runWorkerTestEffect(createWorkerClient("graph-1"))).rejects.toThrow(API_ERROR_CODES.MODEL_NOT_CONFIGURED);
    });
});
