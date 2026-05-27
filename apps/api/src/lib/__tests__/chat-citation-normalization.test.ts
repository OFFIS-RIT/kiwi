import { describe, expect, test } from "bun:test";
import { splitTextWithCitationFences, stringifyCitationFence, type CitationFence } from "@kiwi/ai/citation";
import {
    createCachingCitationResolver,
    normalizeCitationFencesInText,
    normalizeMessageCitationFences,
} from "../chat-citation-normalization";

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

    test("reports when stored message parts were normalized", async () => {
        const legacyCitation = stringifyCitationFence({
            type: "cite",
            sourceId: "source-1",
            unitId: "unit-legacy",
            fileName: "document.pdf",
            fileKey: "graphs/graph-1/document.pdf",
        });

        const result = await normalizeMessageCitationFences(
            [
                { type: "text", text: `Alpha ${legacyCitation}` },
                { type: "reasoning", text: "thinking" },
            ],
            async () => ({
                type: "cite",
                sourceId: "source-1",
                unitId: "unit-1",
                fileId: "file-1",
                fileName: "document.pdf",
            })
        );

        expect(result.changed).toBe(true);
        expect(result.unresolvedCitations).toEqual([]);
        expect(result.parts[1]).toEqual({ type: "reasoning", text: "thinking" });
        expect(firstCitation(result.parts[0]?.type === "text" ? result.parts[0].text : "").fileId).toBe("file-1");
    });

    test("reports unchanged message parts for canonical citations", async () => {
        const canonicalCitation = stringifyCitationFence({
            type: "cite",
            sourceId: "source-1",
            unitId: "unit-1",
            fileId: "file-1",
            fileName: "document.pdf",
        });
        const parts = [{ type: "text" as const, text: `Alpha ${canonicalCitation}` }];
        const result = await normalizeMessageCitationFences(parts, async () => null);

        expect(result.changed).toBe(false);
        expect(result.unresolvedCitations).toEqual([]);
        expect(result.parts).toEqual(parts);
    });

    test("reports unresolved citations that were hidden from display parts", async () => {
        const legacyCitation = stringifyCitationFence({
            type: "cite",
            sourceId: "source-missing",
            unitId: "unit-legacy",
            fileName: "missing.pdf",
            fileKey: "graphs/graph-1/missing.pdf",
        });

        const result = await normalizeMessageCitationFences(
            [{ type: "text", text: `Alpha ${legacyCitation} Omega` }],
            async () => null
        );

        expect(result.changed).toBe(true);
        expect(result.parts).toEqual([{ type: "text", text: "Alpha  Omega" }]);
        expect(result.unresolvedCitations).toEqual([
            {
                partIndex: 0,
                sourceId: "source-missing",
                unitId: "unit-legacy",
                fileName: "missing.pdf",
                fileKey: "graphs/graph-1/missing.pdf",
            },
        ]);
    });

    test("caches unresolved citation lookups across resolver instances", async () => {
        const negativeCache = new Map<string, number>();
        let now = 1000;
        let resolveCalls = 0;
        const createResolver = () =>
            createCachingCitationResolver({
                negativeCache,
                negativeCacheTtlMs: 500,
                now: () => now,
                resolveCitation: async () => {
                    resolveCalls += 1;
                    return null;
                },
            });

        expect(await createResolver()({ type: "cite", sourceId: "missing-source" })).toBeNull();
        expect(await createResolver()({ type: "cite", sourceId: "missing-source" })).toBeNull();
        expect(resolveCalls).toBe(1);

        now = 1600;
        expect(await createResolver()({ type: "cite", sourceId: "missing-source" })).toBeNull();
        expect(resolveCalls).toBe(2);
    });

    test("scopes unresolved citation cache entries by custom key", async () => {
        const negativeCache = new Map<string, number>();
        const citation = { type: "cite" as const, sourceId: "shared-source" };
        const graphBResolver = createCachingCitationResolver({
            negativeCache,
            negativeCacheKey: (citation) => `graph-b:${citation.sourceId}`,
            resolveCitation: async () => null,
        });
        const graphAResolver = createCachingCitationResolver({
            negativeCache,
            negativeCacheKey: (citation) => `graph-a:${citation.sourceId}`,
            resolveCitation: async () => ({
                type: "cite",
                sourceId: citation.sourceId,
                unitId: "unit-1",
                fileId: "file-1",
                fileName: "document.pdf",
            }),
        });

        expect(await graphBResolver(citation)).toBeNull();
        expect([...negativeCache.keys()]).toEqual(["graph-b:shared-source"]);
        expect(await graphAResolver(citation)).toMatchObject({ fileId: "file-1" });
    });

    test("bounds unresolved citation cache size", async () => {
        const negativeCache = new Map<string, number>();
        const resolver = createCachingCitationResolver({
            negativeCache,
            negativeCacheMaxEntries: 2,
            resolveCitation: async () => null,
        });

        expect(await resolver({ type: "cite", sourceId: "source-a" })).toBeNull();
        expect(await resolver({ type: "cite", sourceId: "source-b" })).toBeNull();
        expect(await resolver({ type: "cite", sourceId: "source-c" })).toBeNull();

        expect([...negativeCache.keys()]).toEqual(["source-b", "source-c"]);
    });
});
