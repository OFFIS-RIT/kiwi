import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { metadataPrompt } from "@kiwi/ai/prompts/metadata.prompt";

const METADATA_WORD_LIMIT = 250;

function getWords(text: string): string[] {
    return text.trim().split(/\s+/).filter(Boolean);
}

export function buildMetadataExcerpt(text: string): string | undefined {
    const words = getWords(text);

    if (words.length === 0) {
        return undefined;
    }

    if (words.length <= METADATA_WORD_LIMIT * 2) {
        return ["<text>", words.join(" "), "</text>"].join("\n");
    }

    const start = words.slice(0, METADATA_WORD_LIMIT).join(" ");
    const end = words.slice(-METADATA_WORD_LIMIT).join(" ");

    return [
        "<text>",
        "<start>",
        start,
        "</start>",
        "[... middle of document omitted ...]",
        "<end>",
        end,
        "</end>",
        "</text>",
    ].join("\n");
}

export function normalizeMetadata(text: string): string {
    return text
        .replace(/[\r\n]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

export async function buildMetadata(
    model: LanguageModel,
    documentName: string,
    excerpt: string | undefined
): Promise<string> {
    if (!excerpt) {
        return "";
    }

    const { text } = await generateText({
        model,
        prompt: metadataPrompt(documentName, excerpt),
        temperature: 0.1,
    });

    return normalizeMetadata(text);
}
