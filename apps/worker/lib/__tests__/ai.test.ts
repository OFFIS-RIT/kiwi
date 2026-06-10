import { beforeEach, describe, expect, mock, test } from "bun:test";
import { API_ERROR_CODES } from "@kiwi/contracts/responses";

let clientMockResult: unknown = {
    text: { kind: "text" },
    embedding: { kind: "embedding" },
};
const getClientMock = mock(() => clientMockResult);
const resolveGraphModelOrganizationIdMock = mock(async () => "organization-1");
const resolveWorkerModelConfigMock = mock(async () => ({
    config: {
        text: { type: "openai", model: "gpt-extract", credentials: { apiKey: "key" } },
        embedding: { type: "openai", model: "text-embedding", credentials: { apiKey: "key" } },
    },
}));

mock.module("@kiwi/ai", () => ({
    getClient: getClientMock,
}));

mock.module("@kiwi/ai/models", () => ({
    resolveGraphModelOrganizationId: resolveGraphModelOrganizationIdMock,
    resolveWorkerModelConfig: resolveWorkerModelConfigMock,
}));

mock.module("../../env", () => ({
    env: {
        AUTH_SECRET: "test-auth-secret",
    },
}));

const { createWorkerClient } = await import("../ai");

describe("createWorkerClient", () => {
    beforeEach(() => {
        getClientMock.mockClear();
        resolveGraphModelOrganizationIdMock.mockClear();
        resolveWorkerModelConfigMock.mockClear();
        clientMockResult = {
            text: { kind: "text" },
            embedding: { kind: "embedding" },
        };
    });

    test("resolves the graph organization and builds a required worker client", async () => {
        const client = await createWorkerClient("graph-1");

        expect(resolveGraphModelOrganizationIdMock).toHaveBeenCalledWith("graph-1");
        expect(resolveWorkerModelConfigMock).toHaveBeenCalledWith({
            organizationId: "organization-1",
            secret: "test-auth-secret",
        });
        expect(getClientMock).toHaveBeenCalledWith({
            text: { type: "openai", model: "gpt-extract", credentials: { apiKey: "key" } },
            embedding: { type: "openai", model: "text-embedding", credentials: { apiKey: "key" } },
        });
        expect(client.text as unknown).toEqual({ kind: "text" });
        expect(client.embedding as unknown).toEqual({ kind: "embedding" });
    });

    test("fails when required worker models cannot be instantiated", async () => {
        clientMockResult = {
            text: undefined,
            embedding: { kind: "embedding" },
        };

        await expect(createWorkerClient("graph-1")).rejects.toThrow(API_ERROR_CODES.MODEL_NOT_CONFIGURED);
    });
});
