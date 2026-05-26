import {
    isResolvedCitationFence,
    splitTextWithCitationFences,
    stringifyCitationFence,
    type CitationFence,
    type ResolvedCitationFence,
} from "@kiwi/ai/citation";
import type { MessagePart } from "@kiwi/db/tables/chats";

export type CitationResolver = (citation: CitationFence) => Promise<ResolvedCitationFence | null>;

function needsCanonicalCitation(citation: CitationFence): boolean {
    return !isResolvedCitationFence(citation) || !citation.fileId;
}

export async function normalizeCitationFencesInText(text: string, resolveCitation: CitationResolver): Promise<string> {
    const segments = splitTextWithCitationFences(text);
    const hasLegacyCitation = segments.some(
        (segment) => segment.type === "citation" && needsCanonicalCitation(segment.citation)
    );

    if (!hasLegacyCitation) {
        return text;
    }

    const normalizedSegments = await Promise.all(
        segments.map(async (segment) => {
            if (segment.type === "text") {
                return segment.text;
            }

            if (!needsCanonicalCitation(segment.citation)) {
                return stringifyCitationFence(segment.citation);
            }

            const resolvedCitation = await resolveCitation(segment.citation);
            return resolvedCitation ? stringifyCitationFence(resolvedCitation) : "";
        })
    );

    return normalizedSegments.join("");
}

export async function normalizeMessageCitationFences(
    parts: MessagePart[],
    resolveCitation: CitationResolver
): Promise<{ parts: MessagePart[]; changed: boolean }> {
    let changed = false;
    const normalizedParts = await Promise.all(
        parts.map(async (part) => {
            if (part.type !== "text") {
                return part;
            }

            const text = await normalizeCitationFencesInText(part.text, resolveCitation);
            if (text === part.text) {
                return part;
            }

            changed = true;
            return { ...part, text };
        })
    );

    return { parts: normalizedParts, changed };
}
