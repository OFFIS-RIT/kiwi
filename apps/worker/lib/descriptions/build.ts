import * as Effect from "effect/Effect";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { AI_REQUEST_TIMEOUT, withAiSlotEffect } from "@kiwi/ai/lock";
import { descriptionPromp, updateDescriptionPromp } from "@kiwi/ai/prompts/description.prompt";

const DESCRIPTION_SOURCE_CHUNK_SIZE = 300;
const DESCRIPTION_SOURCE_CHUNK_BUFFER = 25;

type DescriptionGenerator = (args: {
    model: LanguageModel;
    prompt: string;
    temperature: number;
    timeout?: Parameters<typeof generateText>[0]["timeout"];
    abortSignal?: AbortSignal;
}) => Promise<{ text: string }>;

export function chunkDescriptionSources(sourceDescriptions: string[]): string[][] {
    if (sourceDescriptions.length === 0) {
        return [];
    }

    const chunks: string[][] = [];

    for (let index = 0; index < sourceDescriptions.length; index += DESCRIPTION_SOURCE_CHUNK_SIZE) {
        chunks.push(sourceDescriptions.slice(index, index + DESCRIPTION_SOURCE_CHUNK_SIZE));
    }

    if (chunks.length > 1) {
        const tailChunk = chunks[chunks.length - 1]!;
        if (tailChunk.length <= DESCRIPTION_SOURCE_CHUNK_BUFFER) {
            chunks[chunks.length - 2] = [...chunks[chunks.length - 2]!, ...tailChunk];
            chunks.pop();
        }
    }

    return chunks;
}

export function buildDescription(
    model: LanguageModel,
    name: string,
    sourceDescriptions: string[],
    currentDescription: string | undefined,
    deps: {
        generate?: DescriptionGenerator;
    } = {}
): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        if (sourceDescriptions.length === 0) return currentDescription || "";

        let nextDescription = currentDescription;
        const generate = deps.generate ?? generateText;

        for (const sourceChunk of chunkDescriptionSources(sourceDescriptions)) {
            const prompt = nextDescription
                ? updateDescriptionPromp(name, sourceChunk, nextDescription)
                : descriptionPromp(name, sourceChunk);

            const { text } = yield* withAiSlotEffect("text", (signal) =>
                generate({ model, prompt, temperature: 0.1, timeout: AI_REQUEST_TIMEOUT, abortSignal: signal })
            );
            nextDescription = text
                .replace(/[\r\n]+/g, " ")
                .trim()
                .replace(/\s+/g, " ");
        }

        return nextDescription || "";
    });
}
