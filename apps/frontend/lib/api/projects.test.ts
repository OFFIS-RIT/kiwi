import { describe, expect, test } from "vitest";
import type { KiwiApiClient } from "./client";
import { getProjectFileUrl } from "./projects";

const client = { baseURL: "/api" } as KiwiApiClient;

describe("project file URLs", () => {
    test("builds filename-bearing page-aware file URLs", () => {
        expect(
            getProjectFileUrl(client, "graph 1", "file/1", {
                fileName: "Water report #1.pdf",
                page: 5,
            })
        ).toBe("/api/graphs/graph%201/files/file%2F1/Water%20report%20%231.pdf#page=5");
    });

    test("omits invalid page fragments", () => {
        expect(getProjectFileUrl(client, "graph-1", "file-1", { fileName: "source.pdf", page: 0 })).toBe(
            "/api/graphs/graph-1/files/file-1/source.pdf"
        );
    });
});
