import { splitTextWithCitationFences, type CitationFence } from "../citation";

export async function linkifyResearchCitations(
    text: string,
    resolveCitation: (citation: CitationFence) => Promise<string>
) {
    const segments = splitTextWithCitationFences(text);
    const resolvedCitations = await Promise.all(
        segments.map((segment) => (segment.type === "citation" ? resolveCitation(segment.citation) : segment.text))
    );

    return resolvedCitations.join("");
}
