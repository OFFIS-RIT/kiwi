import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { linkifyResearchCitations } from "../mcp";

describe("linkifyResearchCitations", () => {
    test("replaces citation fences with markdown links", async () => {
        const output = await Effect.runPromise(
            linkifyResearchCitations(
                'Alpha :::{"type":"cite","id":"src_1"}::: Omega',
                (citation) => Effect.succeed(`[${citation.sourceId}](https://example.com/${citation.sourceId})`)
            )
        );

        expect(output).toBe("Alpha [src_1](https://example.com/src_1) Omega");
    });

    test("preserves non-citation text exactly", async () => {
        const output = await Effect.runPromise(
            linkifyResearchCitations("Line one\nLine two", () => Effect.succeed("[unused](https://example.com)"))
        );

        expect(output).toBe("Line one\nLine two");
    });

    test("preserves repeated citation order", async () => {
        const output = await Effect.runPromise(
            linkifyResearchCitations(
                'A :::{"type":"cite","id":"src_1"}::: B :::{"type":"cite","id":"src_2"}::: C :::{"type":"cite","id":"src_1"}:::',
                (citation) => Effect.succeed(`[${citation.sourceId}](/${citation.sourceId})`)
            )
        );

        expect(output).toBe("A [src_1](/src_1) B [src_2](/src_2) C [src_1](/src_1)");
    });

    test("resolves citation links concurrently while preserving output order", async () => {
        const resolvers = new Map<string, (value: string) => void>();
        const output = Effect.runPromise(
            linkifyResearchCitations(
                'A :::{"type":"cite","id":"src_1"}::: B :::{"type":"cite","id":"src_2"}::: C',
                (citation) =>
                    Effect.tryPromise(
                        () =>
                            new Promise<string>((resolve) => {
                                resolvers.set(citation.sourceId, resolve);
                            })
                    )
            )
        );

        expect([...resolvers.keys()]).toEqual(["src_1", "src_2"]);

        resolvers.get("src_2")!("[src_2](/src_2)");
        resolvers.get("src_1")!("[src_1](/src_1)");

        expect(await output).toBe("A [src_1](/src_1) B [src_2](/src_2) C");
    });

    test("supports unresolved citation fallbacks", async () => {
        const output = await Effect.runPromise(
            linkifyResearchCitations('Alpha :::{"type":"cite","id":"src_1"}:::', () =>
                Effect.succeed("[source unavailable]")
            )
        );

        expect(output).toBe("Alpha [source unavailable]");
    });
});
