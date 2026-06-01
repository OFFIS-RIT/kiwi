import { describe, expect, test } from "bun:test";

import {
    deleteDerivedFileArtifacts,
    getDerivedFilePrefix,
    getDerivedImagePrefix,
    getDerivedPdfPreviewPrefix,
    getDerivedSourceKey,
} from "../derived-files";

describe("derived-files", () => {
    test("builds deterministic derived storage paths", () => {
        const fileKey = "graphs/graph-1/file-1.pdf";

        expect(getDerivedFilePrefix(fileKey, "file-1")).toBe("graphs/graph-1/file-1.pdf/file-1");
        expect(getDerivedImagePrefix(fileKey, "file-1")).toBe("graphs/graph-1/file-1.pdf/file-1/images");
        expect(getDerivedSourceKey(fileKey, "file-1")).toBe("graphs/graph-1/file-1.pdf/file-1/source.txt");
        expect(getDerivedPdfPreviewPrefix(fileKey, "file-1")).toBe(
            "graphs/graph-1/file-1.pdf/file-1/pdf-preview/v1/scale-1.5"
        );
    });

    test("deletes every derived key for a file prefix", async () => {
        const listedPaths: string[] = [];
        const deletedKeys: string[] = [];
        const keys = await deleteDerivedFileArtifacts("graphs/graph-1/file-1.pdf", "file-1", "bucket-1", {
            listFiles: async (path) => {
                listedPaths.push(path);
                return path === "graphs/graph-1/file-1.pdf/file-1"
                    ? [
                          "graphs/graph-1/file-1.pdf/file-1/source.txt",
                          "graphs/graph-1/file-1.pdf/file-1/images/img-1.png",
                      ]
                    : [];
            },
            deleteFile: async (key) => {
                deletedKeys.push(key);
                return true;
            },
        });

        expect(listedPaths).toEqual(["graphs/graph-1/file-1.pdf/file-1", "graphs/graph-1/derived/file-1"]);
        expect(keys).toEqual([
            "graphs/graph-1/file-1.pdf/file-1/source.txt",
            "graphs/graph-1/file-1.pdf/file-1/images/img-1.png",
        ]);
        expect(deletedKeys).toEqual([
            "graphs/graph-1/file-1.pdf/file-1/source.txt",
            "graphs/graph-1/file-1.pdf/file-1/images/img-1.png",
        ]);
    });

    test("also deletes legacy derived keys for existing files", async () => {
        const deletedKeys: string[] = [];
        const keys = await deleteDerivedFileArtifacts("graphs/graph-1/legacy.pdf", "file-1", "bucket-1", {
            listFiles: async (path) =>
                path === "graphs/graph-1/derived/file-1"
                    ? [
                          "graphs/graph-1/derived/file-1/source.txt",
                          "graphs/graph-1/derived/file-1/images/img-1.png",
                      ]
                    : [],
            deleteFile: async (key) => {
                deletedKeys.push(key);
                return true;
            },
        });

        expect(keys).toEqual([
            "graphs/graph-1/derived/file-1/source.txt",
            "graphs/graph-1/derived/file-1/images/img-1.png",
        ]);
        expect(deletedKeys).toEqual(keys);
    });
});
