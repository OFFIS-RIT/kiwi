import { describe, expect, test } from "bun:test";

import {
    deleteGraphFileArtifacts,
    deleteGraphFileProcessingArtifacts,
    getDerivedFilePrefix,
    getDerivedImagePrefix,
    getDerivedPdfPreviewPrefix,
    getDerivedSourceKey,
    getProcessingArtifactPrefix,
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
        expect(getProcessingArtifactPrefix(fileKey, "file-1")).toBe("graphs/graph-1/file-1.pdf/file-1/derived");
    });

    test("deletes every artifact key for a file", async () => {
        const listedPaths: string[] = [];
        const deletedKeys: string[] = [];
        const keys = await deleteGraphFileArtifacts(
            {
                graphId: "graph-1",
                fileId: "file-1",
                fileKey: "graphs/graph-1/file-1.pdf",
                bucket: "bucket-1",
            },
            {
                listFiles: async (path) => {
                    listedPaths.push(path);
                    switch (path) {
                        case "graphs/graph-1/file-1.pdf/file-1":
                            return [
                                "graphs/graph-1/file-1.pdf/file-1/source.txt",
                                "graphs/graph-1/file-1.pdf/file-1/images/img-1.png",
                            ];
                        case "graphs/graph-1/workflows/v1/file-1":
                            return ["graphs/graph-1/workflows/v1/file-1/units.json"];
                        default:
                            return [];
                    }
                },
                deleteFile: async (key) => {
                    deletedKeys.push(key);
                    return true;
                },
            }
        );

        expect(listedPaths).toEqual([
            "graphs/graph-1/file-1.pdf/file-1",
            "graphs/graph-1/derived/file-1",
            "graphs/graph-1/workflows/v1/file-1",
        ]);
        expect(keys).toEqual([
            "graphs/graph-1/file-1.pdf/file-1/source.txt",
            "graphs/graph-1/file-1.pdf/file-1/images/img-1.png",
            "graphs/graph-1/workflows/v1/file-1/units.json",
        ]);
        expect(deletedKeys).toEqual(keys);
    });

    test("also deletes legacy derived and workflow keys for existing files", async () => {
        const deletedKeys: string[] = [];
        const keys = await deleteGraphFileArtifacts(
            {
                graphId: "graph-1",
                fileId: "file-1",
                fileKey: "graphs/graph-1/legacy.pdf",
                bucket: "bucket-1",
            },
            {
                listFiles: async (path) => {
                    switch (path) {
                        case "graphs/graph-1/derived/file-1":
                            return [
                                "graphs/graph-1/derived/file-1/source.txt",
                                "graphs/graph-1/derived/file-1/images/img-1.png",
                            ];
                        case "graphs/graph-1/workflows/v1/file-1":
                            return [
                                "graphs/graph-1/workflows/v1/file-1/units.json",
                                "graphs/graph-1/workflows/v1/file-1/graph.json",
                            ];
                        default:
                            return [];
                    }
                },
                deleteFile: async (key) => {
                    deletedKeys.push(key);
                    return true;
                },
            }
        );

        expect(keys).toEqual([
            "graphs/graph-1/derived/file-1/source.txt",
            "graphs/graph-1/derived/file-1/images/img-1.png",
            "graphs/graph-1/workflows/v1/file-1/units.json",
            "graphs/graph-1/workflows/v1/file-1/graph.json",
        ]);
        expect(deletedKeys).toEqual(keys);
    });

    test("deletes only transient processing artifacts after successful processing", async () => {
        const listedPaths: string[] = [];
        const deletedKeys: string[] = [];
        const result = await deleteGraphFileProcessingArtifacts(
            {
                graphId: "graph-1",
                fileId: "file-1",
                fileKey: "graphs/graph-1/file-1.pdf",
                bucket: "bucket-1",
            },
            {
                listFiles: async (path) => {
                    listedPaths.push(path);
                    return [
                        "graphs/graph-1/file-1.pdf/file-1/derived/document.json",
                        "graphs/graph-1/file-1.pdf/file-1/derived/units.json",
                        "graphs/graph-1/file-1.pdf/file-1/derived/graph.json",
                    ];
                },
                deleteFile: async (key) => {
                    deletedKeys.push(key);
                    return true;
                },
            }
        );

        expect(listedPaths).toEqual(["graphs/graph-1/file-1.pdf/file-1/derived"]);
        expect(result).toEqual({ deletedKeyCount: 3 });
        expect(deletedKeys).toEqual([
            "graphs/graph-1/file-1.pdf/file-1/derived/document.json",
            "graphs/graph-1/file-1.pdf/file-1/derived/units.json",
            "graphs/graph-1/file-1.pdf/file-1/derived/graph.json",
        ]);
    });
});
