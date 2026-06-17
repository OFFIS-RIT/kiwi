import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Elysia } from "elysia";

let scenario: "list-public" | "create-admin" | "patch-no-changes" | "delete-promote" | "delete-missing" =
    "list-public";
const encryptedCredentialsInputs: Array<{ apiKey: string; url?: string; resourceName?: string }> = [];
const updateCalls: Array<Record<string, unknown>> = [];
const deleteCalls: string[] = [];
let insertedModelValues: Record<string, unknown> | null = null;

const currentModel = {
    id: "db-model-1",
    modelId: "gpt-4o-mini",
    displayName: "GPT 4o Mini",
    type: "text",
    adapter: "openai",
    providerModel: "gpt-4o-mini",
    contextWindow: 64000,
    encryptedCredentials: "encrypted:stored",
    isDefault: true,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    updatedAt: new Date("2026-01-02T03:04:06.000Z"),
};

function limitedRows<T>(rows: T[]) {
    return {
        for: async () => rows,
        then: <TResult1 = T[], TResult2 = never>(
            resolve?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
            _reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) => Promise.resolve(rows).then(resolve, _reject),
    };
}

const transactionDb = {
    select: (_selection?: Record<string, unknown>) => ({
        from: () => ({
            where: () => ({
                limit: () => {
                    if (scenario === "create-admin") {
                        return limitedRows([]);
                    }
                    if (scenario === "patch-no-changes") {
                        return limitedRows([currentModel]);
                    }
                    if (scenario === "delete-promote") {
                        return limitedRows([currentModel]);
                    }
                    if (scenario === "delete-missing") {
                        return limitedRows([]);
                    }
                    return limitedRows([]);
                },
                orderBy: () => ({
                    limit: async () => {
                        if (scenario === "delete-promote") {
                            return [{ id: "db-model-2" }];
                        }
                        return [];
                    },
                }),
            }),
        }),
    }),
    insert: () => ({
        values: (values: Record<string, unknown>) => ({
            returning: async () => {
                insertedModelValues = values;
                return [
                    {
                        ...currentModel,
                        id: "db-model-created",
                        modelId: values.modelId,
                        displayName: values.displayName,
                        type: values.type,
                        adapter: values.adapter,
                        providerModel: values.providerModel,
                        contextWindow: values.contextWindow ?? currentModel.contextWindow,
                        encryptedCredentials: values.encryptedCredentials,
                        isDefault: values.isDefault,
                    },
                ];
            },
        }),
    }),
    update: () => ({
        set: (values: Record<string, unknown>) => {
            updateCalls.push(values);
            return {
                where: () => ({
                    returning: async () => [
                        {
                            ...currentModel,
                            ...("displayName" in values ? { displayName: values.displayName } : {}),
                            ...("adapter" in values ? { adapter: values.adapter } : {}),
                            ...("providerModel" in values ? { providerModel: values.providerModel } : {}),
                            ...("contextWindow" in values ? { contextWindow: values.contextWindow } : {}),
                            ...("encryptedCredentials" in values
                                ? { encryptedCredentials: values.encryptedCredentials }
                                : {}),
                            ...("isDefault" in values ? { isDefault: values.isDefault } : {}),
                        },
                    ],
                    then: <TResult1 = void, TResult2 = never>(
                        resolve?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
                        reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
                    ) => Promise.resolve().then(resolve, reject),
                }),
            };
        },
    }),
    delete: () => ({
        where: () => ({
            then: <TResult1 = void, TResult2 = never>(
                resolve?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
                reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
            ) => {
                deleteCalls.push("delete");
                return Promise.resolve().then(resolve, reject);
            },
        }),
    }),
};

mock.module("@kiwi/ai/models", () => ({
    allocateModelId: (_tx: unknown, _organizationId: string, modelId: string) => Effect.succeed(`allocated-${modelId.trim()}`),
    assertValidModelConfiguration: () => undefined,
    decryptModelCredentials: () => ({
        apiKey: "stored-secret",
        url: "https://stored.example.com",
        resourceName: "stored-resource",
    }),
    encryptModelCredentials: (credentials: { apiKey: string; url?: string; resourceName?: string }) => {
        encryptedCredentialsInputs.push(credentials);
        return `encrypted:${credentials.apiKey}:${credentials.url ?? ""}:${credentials.resourceName ?? ""}`;
    },
    lockModelOrganization: () => Effect.succeed(undefined),
    normalizeModelId: (modelId: string) => modelId.trim().toLowerCase(),
    toAdminModelRecord: (row: typeof currentModel) => ({
        model_id: row.modelId,
        display_name: row.displayName,
        is_default: row.isDefault,
        type: row.type,
        adapter: row.adapter,
        provider_model: row.providerModel,
        context_window: row.contextWindow,
        url: "https://stored.example.com",
        resource_name: "stored-resource",
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
    }),
    toPublicModelRecord: (row: { modelId: string; displayName: string; isDefault: boolean }) => ({
        model_id: row.modelId,
        display_name: row.displayName,
        is_default: row.isDefault,
    }),
}));

mock.module("@kiwi/db", () => ({
    db: {
        select: () => ({
            from: () => ({
                where: () => ({
                    orderBy: async () => [
                        {
                            modelId: "gpt-4o-mini",
                            displayName: "GPT 4o Mini",
                            isDefault: true,
                        },
                        {
                            modelId: "claude-3-5-haiku",
                            displayName: "Claude 3.5 Haiku",
                            isDefault: false,
                        },
                    ],
                }),
            }),
        }),
        transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
    },
}));

mock.module("../../env", () => ({
    env: {
        AUTH_SECRET: "test-secret",
    },
}));

mock.module("../../lib/team/access", () => ({
    requireOrganizationAdmin: () =>
        Effect.succeed({
            organizationId: "org-1",
            role: "admin",
        }),
    requireOrganizationMembership: () =>
        Effect.succeed({
            organizationId: "org-1",
            role: "member",
        }),
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia({ name: "test-auth" }).derive({ as: "scoped" }, () => ({
        user: {
            id: "user-1",
            email: "user@example.com",
            isSystemAdmin: false,
        },
    })),
}));

// Dynamic import is required because this test intentionally mocks route dependencies before module evaluation.
const { modelsRoute } = await import("../models");

describe("models route characterization", () => {
    beforeEach(() => {
        scenario = "list-public";
        encryptedCredentialsInputs.length = 0;
        updateCalls.length = 0;
        deleteCalls.length = 0;
        insertedModelValues = null;
    });

    test("non-admin list returns public text models only", async () => {
        const response = await new Elysia().use(modelsRoute).handle(new Request("http://localhost/models"));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data).toEqual([
            {
                model_id: "gpt-4o-mini",
                display_name: "GPT 4o Mini",
                is_default: true,
            },
            {
                model_id: "claude-3-5-haiku",
                display_name: "Claude 3.5 Haiku",
                is_default: false,
            },
        ]);
    });

    test("admin create encrypts credentials and marks the first type model as default", async () => {
        scenario = "create-admin";

        const response = await new Elysia().use(modelsRoute).handle(
            new Request("http://localhost/models", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model_id: " GPT-4o-Mini ",
                    display_name: " GPT 4o Mini ",
                    type: "text",
                    adapter: "openai",
                    provider_model: " gpt-4o-mini ",
                    credentials: {
                        apiKey: "  secret-key  ",
                        url: "  https://api.example.com  ",
                        resourceName: "  deployment-1  ",
                    },
                }),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(201);
        expect(body.status).toBe("success");
        expect(body.data.model_id).toBe("allocated-GPT-4o-Mini");
        expect(body.data.is_default).toBe(true);
        expect(encryptedCredentialsInputs).toEqual([
            {
                apiKey: "secret-key",
                url: "https://api.example.com",
                resourceName: "deployment-1",
            },
        ]);
        expect(insertedModelValues).toMatchObject({
            modelId: "allocated-GPT-4o-Mini",
            displayName: "GPT 4o Mini",
            providerModel: "gpt-4o-mini",
            encryptedCredentials: "encrypted:secret-key:https://api.example.com:deployment-1",
            isDefault: true,
        });
        expect(updateCalls).toContainEqual({ isDefault: false });
    });

    test("patch with no effective fields returns the current model", async () => {
        scenario = "patch-no-changes";

        const response = await new Elysia().use(modelsRoute).handle(
            new Request("http://localhost/models/gpt-4o-mini", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
            })
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.status).toBe("success");
        expect(body.data).toEqual({
            model_id: "gpt-4o-mini",
            display_name: "GPT 4o Mini",
            is_default: true,
            type: "text",
            adapter: "openai",
            provider_model: "gpt-4o-mini",
            context_window: 64000,
            url: "https://stored.example.com",
            resource_name: "stored-resource",
            created_at: currentModel.createdAt.toISOString(),
            updated_at: currentModel.updatedAt.toISOString(),
        });
        expect(updateCalls).toEqual([]);
    });

    test("deleting a default model promotes the oldest replacement of the same type", async () => {
        scenario = "delete-promote";

        const response = await new Elysia().use(modelsRoute).handle(
            new Request("http://localhost/models/gpt-4o-mini", {
                method: "DELETE",
            })
        );

        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
        expect(deleteCalls).toEqual(["delete"]);
        expect(updateCalls).toContainEqual({ isDefault: true });
    });

    test("missing model returns MODEL_NOT_FOUND", async () => {
        scenario = "delete-missing";

        const response = await new Elysia().use(modelsRoute).handle(
            new Request("http://localhost/models/missing-model", {
                method: "DELETE",
            })
        );
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body.status).toBe("error");
        expect(body.code).toBe("MODEL_NOT_FOUND");
    });
});
