import {
    isResolvedCitationFence,
    splitTextWithCitationFences,
    stringifyCitationFence,
    type CitationFence,
    type ResolvedCitationFence,
} from "@kiwi/ai/citation";
import type { MessagePart } from "@kiwi/contracts/chat";
import * as Effect from "effect/Effect";

export type CitationResolver = (citation: CitationFence) => Promise<ResolvedCitationFence | null>;

export const DEFAULT_CITATION_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CITATION_NEGATIVE_CACHE_MAX_ENTRIES = 2048;

function chatEffect<T>(thunk: () => Promise<T>): Effect.Effect<T, unknown> {
    return Effect.tryPromise({
        try: thunk,
        catch: (error) => error,
    });
}

export type CachingCitationResolverOptions = {
    resolveCitation: (sourceId: string) => Promise<ResolvedCitationFence | null>;
    negativeCacheKey?: (citation: CitationFence) => string;
    negativeCache?: Map<string, number>;
    negativeCacheTtlMs?: number;
    negativeCacheMaxEntries?: number;
    now?: () => number;
};

export type UnresolvedCitation = {
    partIndex: number;
    sourceId: string;
    unitId?: string;
    fileId?: string;
    fileName?: string;
    fileKey?: string;
};

type NormalizedCitationText = {
    text: string;
    unresolvedCitations: UnresolvedCitation[];
};

function needsCanonicalCitation(citation: CitationFence): boolean {
    return !isResolvedCitationFence(citation) || !citation.fileId;
}

export function createCachingCitationResolver(options: CachingCitationResolverOptions): CitationResolver {
    const citationCache = new Map<string, Promise<ResolvedCitationFence | null>>();
    const negativeCache = options.negativeCache ?? new Map<string, number>();
    const negativeCacheTtlMs = options.negativeCacheTtlMs ?? DEFAULT_CITATION_NEGATIVE_CACHE_TTL_MS;
    const negativeCacheMaxEntries = Math.max(
        0,
        Math.floor(options.negativeCacheMaxEntries ?? DEFAULT_CITATION_NEGATIVE_CACHE_MAX_ENTRIES)
    );
    const getNegativeCacheKey = options.negativeCacheKey ?? ((citation: CitationFence) => citation.sourceId);
    const now = options.now ?? Date.now;

    return (citation) => {
        const sourceId = citation.sourceId;
        const cacheKey = getNegativeCacheKey(citation);
        const cachedMissingUntil = negativeCache.get(cacheKey);
        if (cachedMissingUntil !== undefined) {
            if (cachedMissingUntil > now()) {
                negativeCache.delete(cacheKey);
                negativeCache.set(cacheKey, cachedMissingUntil);
                return Promise.resolve(null);
            }

            negativeCache.delete(cacheKey);
        }

        let resolvedCitation = citationCache.get(sourceId);
        if (!resolvedCitation) {
            resolvedCitation = options.resolveCitation(sourceId).then((resolved) => {
                if (resolved) {
                    negativeCache.delete(cacheKey);
                    return resolved;
                }

                setNegativeCacheEntry(negativeCache, cacheKey, now() + negativeCacheTtlMs, negativeCacheMaxEntries);
                return null;
            });
            citationCache.set(sourceId, resolvedCitation);
        }

        return resolvedCitation;
    };
}

function setNegativeCacheEntry(
    negativeCache: Map<string, number>,
    cacheKey: string,
    expiresAt: number,
    maxEntries: number
): void {
    negativeCache.delete(cacheKey);

    if (maxEntries <= 0) {
        return;
    }

    negativeCache.set(cacheKey, expiresAt);

    while (negativeCache.size > maxEntries) {
        const oldestCacheKey = negativeCache.keys().next().value;
        if (oldestCacheKey === undefined) {
            return;
        }

        negativeCache.delete(oldestCacheKey);
    }
}

function toUnresolvedCitation(partIndex: number, citation: CitationFence): UnresolvedCitation {
    return {
        partIndex,
        sourceId: citation.sourceId,
        ...(citation.unitId ? { unitId: citation.unitId } : {}),
        ...(citation.fileId ? { fileId: citation.fileId } : {}),
        ...(citation.fileName ? { fileName: citation.fileName } : {}),
        ...(citation.fileKey ? { fileKey: citation.fileKey } : {}),
    };
}

function normalizeCitationFencesInTextDetailed(
    text: string,
    resolveCitation: CitationResolver,
    partIndex: number
): Effect.Effect<NormalizedCitationText, unknown> {
    const segments = splitTextWithCitationFences(text);
    const hasLegacyCitation = segments.some(
        (segment) => segment.type === "citation" && needsCanonicalCitation(segment.citation)
    );

    if (!hasLegacyCitation) {
        return Effect.succeed({ text, unresolvedCitations: [] });
    }

    return Effect.gen(function* () {
        const normalizedSegments: Array<{ text: string; unresolvedCitation?: UnresolvedCitation }> = yield* Effect.all(
            segments.map((segment) => {
                if (segment.type === "text") {
                    return Effect.succeed({ text: segment.text });
                }

                if (!needsCanonicalCitation(segment.citation)) {
                    return Effect.succeed({ text: stringifyCitationFence(segment.citation) });
                }

                return Effect.gen(function* () {
                    const resolvedCitation = yield* chatEffect(() => resolveCitation(segment.citation));
                    if (resolvedCitation) {
                        return { text: stringifyCitationFence(resolvedCitation) };
                    }

                    return {
                        text: "",
                        unresolvedCitation: toUnresolvedCitation(partIndex, segment.citation),
                    };
                });
            })
        );

        return {
            text: normalizedSegments.map((segment) => segment.text).join(""),
            unresolvedCitations: normalizedSegments.flatMap((segment) =>
                segment.unresolvedCitation ? [segment.unresolvedCitation] : []
            ),
        };
    });
}

export function normalizeCitationFencesInText(
    text: string,
    resolveCitation: CitationResolver
): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        const normalized = yield* normalizeCitationFencesInTextDetailed(text, resolveCitation, 0);
        return normalized.text;
    });
}

export function normalizeMessageCitationFences(
    parts: MessagePart[],
    resolveCitation: CitationResolver
): Effect.Effect<{ parts: MessagePart[]; changed: boolean; unresolvedCitations: UnresolvedCitation[] }, unknown> {
    return Effect.gen(function* () {
        let changed = false;
        const normalized = yield* Effect.all(
            parts.map((part, partIndex) => {
                if (part.type !== "text") {
                    return Effect.succeed({ part, unresolvedCitations: [] });
                }

                return Effect.gen(function* () {
                    const { text, unresolvedCitations } = yield* normalizeCitationFencesInTextDetailed(
                        part.text,
                        resolveCitation,
                        partIndex
                    );
                    if (text === part.text) {
                        return { part, unresolvedCitations };
                    }

                    changed = true;
                    return { part: { ...part, text }, unresolvedCitations };
                });
            })
        );

        return {
            parts: normalized.map((item) => item.part),
            changed,
            unresolvedCitations: normalized.flatMap((item) => item.unresolvedCitations),
        };
    });
}
