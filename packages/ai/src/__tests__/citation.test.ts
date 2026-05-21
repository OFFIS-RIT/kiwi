import { describe, expect, test } from "bun:test";
import { parseCitationFence, stringifyCitationFence, type ResolvedCitationFence } from "../citation";

describe("citation fences", () => {
    test("round-trips resolved file and page metadata", () => {
        const citation: ResolvedCitationFence = {
            type: "cite",
            sourceId: "source-1",
            unitId: "unit-1",
            fileId: "file-1",
            fileName: "document.pdf",
            fileKey: "graphs/graph-1/document.pdf",
            fileType: "pdf",
            startPage: 3,
            endPage: 5,
        };

        expect(parseCitationFence(stringifyCitationFence(citation))).toEqual(citation);
    });

    test("keeps model-facing citation fences minimal", () => {
        expect(
            stringifyCitationFence(
                {
                    type: "cite",
                    sourceId: "source-1",
                    unitId: "unit-1",
                    fileId: "file-1",
                    fileName: "document.pdf",
                    fileKey: "graphs/graph-1/document.pdf",
                    fileType: "pdf",
                    startPage: 3,
                    endPage: 5,
                },
                { forModel: true }
            )
        ).toBe(':::{"type":"cite","id":"source-1"}:::');
    });
});
