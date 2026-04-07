import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@kiwi/auth/client", () => ({
    authClient: { signOut: vi.fn() },
}));

const fetchSpy = vi.fn();

(globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

import { authClient } from "@kiwi/auth/client";
import { ApiError, apiClient } from "./client";

describe("API client", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test("GET includes cookies", async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ data: "ok" }),
        });

        const result = await apiClient.get("/test");

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [, options] = fetchSpy.mock.calls[0];
        expect(options.credentials).toBe("include");
        expect(options.headers.Authorization).toBeUndefined();
        expect(options.method).toBe("GET");
        expect(result).toEqual({ data: "ok" });
    });

    test("POST sends JSON body with correct headers", async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ id: 1 }),
        });

        await apiClient.post("/items", { name: "test" });

        const [, options] = fetchSpy.mock.calls[0];
        expect(options.headers["Content-Type"]).toBe("application/json");
        expect(options.method).toBe("POST");
        expect(options.body).toBe(JSON.stringify({ name: "test" }));
    });

    test("throws ApiError on non-ok response", async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            text: () =>
                Promise.resolve(
                    JSON.stringify({
                        status: "error",
                        message: "Internal server error",
                        code: "INTERNAL_SERVER_ERROR",
                    })
                ),
        });

        await expect(apiClient.get("/fail")).rejects.toThrow(ApiError);
    });

    test("signs out on 401", async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: () => Promise.resolve(""),
        });

        await expect(apiClient.get("/protected")).rejects.toThrow(ApiError);
        expect(authClient.signOut).toHaveBeenCalled();
    });

    test("surfaces envelope error details", async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            text: () =>
                Promise.resolve(
                    JSON.stringify({
                        status: "error",
                        message: "Forbidden",
                        code: "FORBIDDEN",
                    })
                ),
        });

        await expect(apiClient.get("/forbidden")).rejects.toMatchObject({
            message: "Forbidden",
            code: "FORBIDDEN",
        });
    });

    test("returns null for 204 No Content", async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 204,
        });

        const result = await apiClient.delete("/items/1");
        expect(result).toBeNull();
    });
});
