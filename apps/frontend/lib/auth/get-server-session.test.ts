// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
    headers: vi.fn(async () => ({
        get: (k: string) => (k === "cookie" ? "session=abc" : null),
    })),
}));

vi.mock("./transport", () => ({
    fetchSessionRaw: vi.fn(),
}));

import { fetchSessionRaw } from "./transport";
import { getServerSession } from "./get-server-session";

describe("getServerSession", () => {
    beforeEach(() => {
        vi.mocked(fetchSessionRaw).mockReset();
        process.env.AUTH_URL = "http://auth.test/auth";
        delete process.env.INTERNAL_AUTH_URL;
    });

    it("returns null when no auth URL configured", async () => {
        delete process.env.AUTH_URL;
        expect(await getServerSession()).toBeNull();
    });

    it("returns null when transport returns null", async () => {
        vi.mocked(fetchSessionRaw).mockResolvedValue(null);
        expect(await getServerSession()).toBeNull();
    });

    it("returns null when response has no user", async () => {
        vi.mocked(fetchSessionRaw).mockResolvedValue({ user: null, session: null });
        expect(await getServerSession()).toBeNull();
    });

    it("returns session data when valid", async () => {
        const sessionData = {
            user: { id: "u1", name: "Test", email: "t@e.com", role: "user" },
            session: { id: "s1" },
        };
        vi.mocked(fetchSessionRaw).mockResolvedValue(sessionData);
        expect(await getServerSession()).toEqual(sessionData);
    });

    it("prefers INTERNAL_AUTH_URL when set", async () => {
        process.env.INTERNAL_AUTH_URL = "http://server:4321/auth";
        vi.mocked(fetchSessionRaw).mockResolvedValue({ user: { id: "u1" }, session: {} });
        await getServerSession();
        expect(fetchSessionRaw).toHaveBeenCalledWith("http://server:4321/auth", "session=abc");
    });
});
