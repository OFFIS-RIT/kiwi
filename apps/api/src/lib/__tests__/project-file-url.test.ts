import { describe, expect, test } from "bun:test";
import { getProjectFileProxyPath, getProjectFileProxyUrl, getPublicApiBaseUrl } from "../project-file-url";

describe("project file proxy URLs", () => {
    test("builds page-aware proxy paths", () => {
        expect(getProjectFileProxyPath("graph 1", "file/1", { page: 3 })).toBe(
            "/graphs/graph%201/files/file%2F1#page=3"
        );
        expect(
            getProjectFileProxyPath("graph-1", "file-1", {
                fileName: "Water report #1.pdf",
                page: 3,
                token: "abc.123",
            })
        ).toBe("/graphs/graph-1/files/file-1/Water%20report%20%231.pdf?token=abc.123#page=3");
        expect(getProjectFileProxyPath("graph-1", "file-1", { page: 0 })).toBe("/graphs/graph-1/files/file-1");
    });

    test("prefixes proxy paths with an API origin", () => {
        expect(
            getProjectFileProxyUrl("https://api.example.com/", "graph-1", "file-1", {
                fileName: "source.pdf",
                page: 2,
            })
        ).toBe("https://api.example.com/graphs/graph-1/files/file-1/source.pdf#page=2");
    });

    test("resolves configured relative API URLs against the request origin", () => {
        const request = new Request("http://server:4321/mcp", {
            headers: {
                host: "internal:4321",
                "x-forwarded-host": "kiwi.example.com",
                "x-forwarded-proto": "https",
            },
        });

        expect(getPublicApiBaseUrl(request, "/api")).toBe("http://server:4321/api");
        expect(getPublicApiBaseUrl(request, "https://api.example.com/")).toBe("https://api.example.com");
    });
});
