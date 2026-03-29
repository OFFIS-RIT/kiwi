import { describe, expect, test, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: vi.fn() },
  getToken: vi.fn().mockResolvedValue("test-jwt-token"),
  clearTokenCache: vi.fn(),
}));

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

import { apiClient, ApiError } from "./client";
import { clearTokenCache } from "@/lib/auth-client";

describe("API client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("GET sends Authorization header with token", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: "ok" }),
    });

    const result = await apiClient.get("/test");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer test-jwt-token");
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
      text: () => Promise.resolve("server error"),
    });

    await expect(apiClient.get("/fail")).rejects.toThrow(ApiError);
  });

  test("clears token cache and signs out on 401", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve(""),
    });

    await expect(apiClient.get("/protected")).rejects.toThrow(ApiError);
    expect(clearTokenCache).toHaveBeenCalled();
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
