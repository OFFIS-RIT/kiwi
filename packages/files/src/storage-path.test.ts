import { describe, expect, test } from "bun:test";
import {
    getDerivedFilePrefix,
    getDerivedImagePrefix,
    getDerivedPdfPreviewPrefix,
    getDerivedSourceKey,
    getGraphFileArtifactPaths,
    getGraphFileKey,
    getProcessingArtifactPrefix,
} from ".";

describe("storage paths", () => {
    test("stores graph files directly under the graph root by file id", () => {
        expect(getGraphFileKey("graph-1", "file-1", "Report.PDF")).toBe("graphs/graph-1/file-1.pdf");
        expect(getGraphFileKey("graph-1", "file-1", "README")).toBe("graphs/graph-1/file-1");
    });

    test("stores derived artifacts under the original file key and file id", () => {
        const fileKey = "graphs/graph-1/file-1.pdf";

        expect(getDerivedFilePrefix(fileKey, "file-1")).toBe("graphs/graph-1/file-1.pdf/file-1");
        expect(getDerivedImagePrefix(fileKey, "file-1")).toBe("graphs/graph-1/file-1.pdf/file-1/images");
        expect(getDerivedSourceKey(fileKey, "file-1")).toBe("graphs/graph-1/file-1.pdf/file-1/source.txt");
        expect(getDerivedPdfPreviewPrefix(fileKey, "file-1")).toBe(
            "graphs/graph-1/file-1.pdf/file-1/pdf-preview/v1/scale-1.5"
        );
        expect(getProcessingArtifactPrefix(fileKey, "file-1")).toBe("graphs/graph-1/file-1.pdf/file-1/derived");
    });

    test("groups current and legacy graph file artifact paths", () => {
        expect(
            getGraphFileArtifactPaths({
                graphId: "graph-1",
                fileId: "file-1",
                fileKey: "graphs/graph-1/file-1.pdf",
            })
        ).toEqual({
            derivedPrefix: "graphs/graph-1/file-1.pdf/file-1",
            derivedImagePrefix: "graphs/graph-1/file-1.pdf/file-1/images",
            derivedSourceKey: "graphs/graph-1/file-1.pdf/file-1/source.txt",
            derivedPdfPreviewPrefix: "graphs/graph-1/file-1.pdf/file-1/pdf-preview/v1/scale-1.5",
            processingPrefix: "graphs/graph-1/file-1.pdf/file-1/derived",
            cleanupPrefixes: [
                "graphs/graph-1/file-1.pdf/file-1",
                "graphs/graph-1/derived/file-1",
                "graphs/graph-1/workflows/v1/file-1",
            ],
        });
    });
});
