import * as Effect from "effect/Effect";
import { splitTextWithCitationFences, type CitationFence } from "../citation";

export function linkifyResearchCitations<E = never, R = never>(
    text: string,
    resolveCitation: (citation: CitationFence) => Effect.Effect<string, E, R>
): Effect.Effect<string, E, R> {
    const segments = splitTextWithCitationFences(text);

    return Effect.all(
        segments.map((segment) =>
            segment.type === "citation" ? resolveCitation(segment.citation) : Effect.succeed(segment.text)
        ),
        { concurrency: "unbounded" }
    ).pipe(Effect.map((resolvedCitations) => resolvedCitations.join("")));
}
