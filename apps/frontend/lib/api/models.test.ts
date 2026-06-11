import { describe, expect, test, vi } from "vitest";
import type { KiwiApiClient } from "./client";
import {
    createModel,
    deleteModel,
    fetchAdminModels,
    fetchSelectableModels,
    setDefaultModel,
    updateModel,
} from "./models";

const publicModel = { model_id: "gpt-41-mini", display_name: "GPT-4.1 mini" };

const adminModel = {
    ...publicModel,
    type: "text" as const,
    adapter: "openai" as const,
    provider_model: "gpt-4.1-mini",
    is_default: true,
    created_at: "2026-06-09T08:02:27.000Z",
    updated_at: "2026-06-09T08:02:27.000Z",
};

describe("selectable models", () => {
    test("fetches text models only, so admins don't see other types in chat", async () => {
        const get = vi.fn(async () => ({ status: "success" as const, data: [publicModel] }));
        const client = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await expect(fetchSelectableModels(client)).resolves.toEqual([publicModel]);
        expect(get).toHaveBeenCalledWith("/models?type=text");
    });
});

describe("admin models", () => {
    test("fetches all models without a type filter", async () => {
        const get = vi.fn(async () => ({ status: "success" as const, data: [adminModel] }));
        const client = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await expect(fetchAdminModels(client)).resolves.toEqual([adminModel]);
        expect(get).toHaveBeenCalledWith("/models");
    });

    test("filters the admin list by type", async () => {
        const get = vi.fn(async () => ({ status: "success" as const, data: [adminModel] }));
        const client = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await fetchAdminModels(client, "embedding");
        expect(get).toHaveBeenCalledWith("/models?type=embedding");
    });

    test("creates a model and returns the canonical record", async () => {
        const post = vi.fn(async () => ({ status: "success" as const, data: adminModel }));
        const client = { baseURL: "/api", post } as unknown as KiwiApiClient;
        const input = {
            model_id: "GPT 4.1 Mini",
            display_name: "GPT-4.1 mini",
            type: "text" as const,
            adapter: "openai" as const,
            provider_model: "gpt-4.1-mini",
            credentials: { apiKey: "secret" },
            is_default: true,
        };

        await expect(createModel(client, input)).resolves.toEqual(adminModel);
        expect(post).toHaveBeenCalledWith("/models", input);
    });

    test("patches editable fields on the encoded model path", async () => {
        const patch = vi.fn(async () => ({ status: "success" as const, data: adminModel }));
        const client = { baseURL: "/api", patch } as unknown as KiwiApiClient;

        await updateModel(client, "model/1", { display_name: "Renamed" });
        expect(patch).toHaveBeenCalledWith("/models/model%2F1", { display_name: "Renamed" });
    });

    test("sets the default for the model's type", async () => {
        const post = vi.fn(async () => ({ status: "success" as const, data: adminModel }));
        const client = { baseURL: "/api", post } as unknown as KiwiApiClient;

        await setDefaultModel(client, "gpt-41-mini");
        expect(post).toHaveBeenCalledWith("/models/gpt-41-mini/default");
    });

    test("deletes a model", async () => {
        const del = vi.fn(async () => null);
        const client = { baseURL: "/api", delete: del } as unknown as KiwiApiClient;

        await deleteModel(client, "gpt-41-mini");
        expect(del).toHaveBeenCalledWith("/models/gpt-41-mini");
    });
});
