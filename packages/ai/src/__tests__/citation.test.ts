import { describe, expect, test } from "bun:test";
import { isPDFCitation, parseCitationFence, stringifyCitationFence, type ResolvedCitationFence } from "../citation";

describe("citation fences", () => {
    test("round-trips resolved file and page metadata", () => {
        const citation: ResolvedCitationFence = {
            type: "cite",
            sourceId: "source-1",
            unitId: "unit-1",
            fileId: "file-1",
            fileName: "document.pdf",
            fileType: "pdf",
            startPage: 3,
            endPage: 5,
        };

        expect(parseCitationFence(stringifyCitationFence(citation))).toEqual(citation);
    });

    test("round-trips external provider open URLs", () => {
        const citation: ResolvedCitationFence = {
            type: "cite",
            sourceId: "source-1",
            unitId: "unit-1",
            fileId: "file-1",
            fileName: "source.ts",
            fileType: "code",
            externalUrl: "https://github.com/acme/widgets/blob/commit-1/source.ts",
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
                    fileType: "pdf",
                    startPage: 3,
                    endPage: 5,
                    externalUrl: "https://github.com/acme/widgets/blob/commit-1/document.pdf",
                },
                { forModel: true }
            )
        ).toBe(':::{"type":"cite","id":"source-1"}:::');
    });

    test("keeps legacy file-key citations parseable", () => {
        expect(
            parseCitationFence(
                ':::{"type":"cite","sourceId":"source-1","unitId":"unit-1","fileName":"document.pdf","fileKey":"graphs/graph-1/document.pdf"}:::'
            )
        ).toMatchObject({
            type: "cite",
            sourceId: "source-1",
            unitId: "unit-1",
            fileName: "document.pdf",
            fileKey: "graphs/graph-1/document.pdf",
        });
    });

    test("detects PDF citations from file type or filename", () => {
        expect(isPDFCitation({ fileName: "report.docx", fileType: "pdf" })).toBe(true);
        expect(isPDFCitation({ fileName: "report.PDF" })).toBe(true);
        expect(isPDFCitation({ fileName: "report.docx", fileType: "doc" })).toBe(false);
    });
});
