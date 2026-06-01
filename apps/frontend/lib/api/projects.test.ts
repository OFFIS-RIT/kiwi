import { describe, expect, test, vi } from "vitest";
import type { KiwiApiClient } from "./client";
import { fetchSourceReference, fetchSourceReferences, getProjectFileUrl } from "./projects";

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

describe("project source references", () => {
    test("fetches source references from the graph source endpoint", async () => {
        const reference = {
            source_id: "source-1",
            description: "Reference",
            unit: {
                id: "unit-1",
                project_file_id: "file-1",
                start_page: null,
                end_page: null,
                file_name: "document.txt",
                file_type: "text",
                mime_type: "text/plain",
                created_at: null,
                updated_at: null,
            },
            chunks: [{ type: "text" as const, chunk_id: 1, text: "Alpha evidence" }],
            pdf_regions: [],
        };
        const get = vi.fn(async () => ({ status: "success" as const, data: reference }));
        const apiClient = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await expect(fetchSourceReference(apiClient, "graph-1", "source-1")).resolves.toEqual(reference);
        expect(get).toHaveBeenCalledWith("/graphs/graph-1/sources/source-1/reference");
    });

    test("fetches source references in one batch request", async () => {
        const reference = {
            source_id: "source-1",
            description: "Reference",
            unit: {
                id: "unit-1",
                project_file_id: "file-1",
                start_page: null,
                end_page: null,
                file_name: "document.txt",
                file_type: "text",
                mime_type: "text/plain",
                created_at: null,
                updated_at: null,
            },
            chunks: [{ type: "text" as const, chunk_id: 1, text: "Alpha evidence" }],
            pdf_regions: [],
        };
        const batch = { items: [reference], missing_source_ids: ["source-2"] };
        const post = vi.fn(async () => ({ status: "success" as const, data: batch }));
        const apiClient = { baseURL: "/api", post } as unknown as KiwiApiClient;

        await expect(fetchSourceReferences(apiClient, "graph-1", ["source-1", "source-1", " source-2 "])).resolves.toEqual(
            batch
        );
        expect(post).toHaveBeenCalledWith("/graphs/graph-1/sources/references", {
            source_ids: ["source-1", "source-2"],
        });
    });
});
