import { describe, expect, test } from "bun:test";
import {
    getDerivedFilePrefix,
    getDerivedImagePrefix,
    getDerivedPdfPreviewPrefix,
    getDerivedSourceKey,
    getGraphFileKey,
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
    });
});
