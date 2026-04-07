import { describe, expect, test } from "bun:test";

import {
    deleteDerivedFileArtifacts,
    getDerivedFilePrefix,
    getDerivedImagePrefix,
    getDerivedSourceKey,
} from "../derived-files";

describe("derived-files", () => {
    test("builds deterministic derived storage paths", () => {
        expect(getDerivedFilePrefix("graph-1", "file-1")).toBe("graphs/graph-1/derived/file-1");
        expect(getDerivedImagePrefix("graph-1", "file-1")).toBe("graphs/graph-1/derived/file-1/images");
        expect(getDerivedSourceKey("graph-1", "file-1")).toBe("graphs/graph-1/derived/file-1/source.txt");
    });

    test("deletes every derived key for a file prefix", async () => {
        const listedPaths: string[] = [];
        const deletedKeys: string[] = [];
        const keys = await deleteDerivedFileArtifacts("graph-1", "file-1", "bucket-1", {
            listFiles: async (path) => {
                listedPaths.push(path);
                return ["graphs/graph-1/derived/file-1/source.txt", "graphs/graph-1/derived/file-1/images/img-1.png"];
            },
            deleteFile: async (key) => {
                deletedKeys.push(key);
                return true;
            },
        });

        expect(listedPaths).toEqual(["graphs/graph-1/derived/file-1"]);
        expect(keys).toEqual([
            "graphs/graph-1/derived/file-1/source.txt",
            "graphs/graph-1/derived/file-1/images/img-1.png",
        ]);
        expect(deletedKeys).toEqual([
            "graphs/graph-1/derived/file-1/source.txt",
            "graphs/graph-1/derived/file-1/images/img-1.png",
        ]);
    });
});
