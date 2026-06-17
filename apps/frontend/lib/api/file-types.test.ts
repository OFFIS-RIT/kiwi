import { describe, expect, test, vi } from "vitest";
import type { KiwiApiClient } from "./client";
import { fetchFileTypeConfigs, updateFileTypeConfig } from "./file-types";

const pdfConfig = {
    file_type: "pdf" as const,
    loader: "pdf",
    chunker: "semantic",
    chunk_size: 2000,
    document_mode: "hybrid" as const,
    chunk_size_editable: true,
    document_mode_editable: true,
};

describe("file type processing config API", () => {
    test("fetches resolved file type configs", async () => {
        const get = vi.fn(async () => ({ status: "success" as const, data: [pdfConfig] }));
        const client = { baseURL: "/api", get } as unknown as KiwiApiClient;

        await expect(fetchFileTypeConfigs(client)).resolves.toEqual([pdfConfig]);
        expect(get).toHaveBeenCalledWith("/file-types/");
    });

    test("patches the encoded file type path", async () => {
        const patch = vi.fn(async () => ({ status: "success" as const, data: pdfConfig }));
        const client = { baseURL: "/api", patch } as unknown as KiwiApiClient;

        const result = await updateFileTypeConfig(client, "pdf", { chunk_size: 1600 });

        expect(patch).toHaveBeenCalledWith("/file-types/pdf", { chunk_size: 1600 });
        expect(result).toEqual(pdfConfig);
    });
});
