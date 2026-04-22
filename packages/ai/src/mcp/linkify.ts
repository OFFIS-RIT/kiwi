import { splitTextWithCitationFences, type CitationFence } from "../citation";

export async function linkifyResearchCitations(
    text: string,
    resolveCitation: (citation: CitationFence) => Promise<string>
) {
    const segments = splitTextWithCitationFences(text);
    let output = "";

    for (const segment of segments) {
        if (segment.type === "text") {
            output += segment.text;
            continue;
        }

        output += await resolveCitation(segment.citation);
    }

    return output;
}
