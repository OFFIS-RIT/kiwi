import { describe, expect, mock, test } from "bun:test";

import { buildDescription, chunkDescriptionSources } from "../description";

describe("chunkDescriptionSources", () => {
    test("merges a small tail chunk into the previous chunk", () => {
        const chunks = chunkDescriptionSources(Array.from({ length: 305 }, (_, index) => `source-${index}`));

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toHaveLength(305);
    });

    test("keeps larger tail chunks separate", () => {
        const chunks = chunkDescriptionSources(Array.from({ length: 650 }, (_, index) => `source-${index}`));

        expect(chunks).toHaveLength(3);
        expect(chunks.map((chunk) => chunk.length)).toEqual([300, 300, 50]);
    });

    test("merges the final 25 sources into the previous chunk", () => {
        const chunks = chunkDescriptionSources(Array.from({ length: 625 }, (_, index) => `source-${index}`));

        expect(chunks).toHaveLength(2);
        expect(chunks.map((chunk) => chunk.length)).toEqual([300, 325]);
    });
});

describe("buildDescription", () => {
    test("uses one initial pass then update passes for new items", async () => {
        const calls: string[] = [];
        const generateTextMock = mock(async ({ prompt }: { prompt: string }) => {
            calls.push(prompt);
            return { text: ` description-${calls.length} ` };
        });

        const description = await buildDescription(
            {} as never,
            "Entity",
            Array.from({ length: 625 }, (_, index) => `source-${index}`),
            undefined,
            { generate: generateTextMock as typeof generateTextMock }
        );

        expect(description).toBe("description-2");
        expect(generateTextMock).toHaveBeenCalledTimes(2);
        expect(calls[0]).toContain("entity_descriptions:");
        expect(calls[1]).toContain("**current_description:**");
        expect(calls[1]).toContain("description-1");
    });

    test("uses update passes only for existing items", async () => {
        const calls: string[] = [];
        const generateTextMock = mock(async ({ prompt }: { prompt: string }) => {
            calls.push(prompt);
            return { text: ` updated-${calls.length} ` };
        });

        const description = await buildDescription(
            {} as never,
            "Entity",
            Array.from({ length: 305 }, (_, index) => `source-${index}`),
            "existing description",
            { generate: generateTextMock as typeof generateTextMock }
        );

        expect(description).toBe("updated-1");
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(calls[0]).toContain("**current_description:**");
        expect(calls[0]).toContain("existing description");
    });
});
