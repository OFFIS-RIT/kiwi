import {
    isResolvedCitationFence,
    splitTextWithCitationFences,
    stringifyCitationFence,
    type CitationFence,
    type ResolvedCitationFence,
} from "@kiwi/ai/citation";

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
