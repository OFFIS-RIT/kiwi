import { describe, expect, test } from "bun:test";
import { splitTextWithCitationFences, stringifyCitationFence, type CitationFence } from "@kiwi/ai/citation";
import { normalizeCitationFencesInText } from "../chat-citation-normalization";

function firstCitation(text: string): CitationFence {
    const segment = splitTextWithCitationFences(text).find((part) => part.type === "citation");
    if (!segment || segment.type !== "citation") {
        throw new Error("Expected a citation fence");
    }

    return segment.citation;
}

describe("chat citation normalization", () => {
    test("normalizes legacy file-key citations to canonical file-id citations", async () => {
        const normalized = await normalizeCitationFencesInText(
            `Alpha ${stringifyCitationFence({
                type: "cite",
                sourceId: "source-1",
                unitId: "unit-legacy",
                fileName: "document.pdf",
                fileKey: "graphs/graph-1/document.pdf",
                fileType: "pdf",
                startPage: 3,
                endPage: 4,
            })} Omega`,
            async () => ({
                type: "cite",
                sourceId: "source-1",
                unitId: "unit-1",
                fileId: "file-1",
                fileName: "document.pdf",
                fileType: "pdf",
                startPage: 3,
                endPage: 4,
            })
        );

        const citation = firstCitation(normalized);

        expect(normalized).toContain("Alpha ");
        expect(normalized).toContain(" Omega");
        expect(citation.fileId).toBe("file-1");
        expect(citation.fileKey).toBeUndefined();
        expect(citation.unitId).toBe("unit-1");
    });

    test("keeps canonical file-id citations without resolving again", async () => {
        let resolverCalls = 0;
        const text = `Alpha ${stringifyCitationFence({
            type: "cite",
            sourceId: "source-1",
            unitId: "unit-1",
            fileId: "file-1",
            fileName: "document.pdf",
            fileType: "pdf",
            startPage: 3,
            endPage: 4,
        })} Omega`;

        const normalized = await normalizeCitationFencesInText(text, async () => {
            resolverCalls += 1;
            return null;
        });

        expect(normalized).toBe(text);
        expect(resolverCalls).toBe(0);
    });
});
