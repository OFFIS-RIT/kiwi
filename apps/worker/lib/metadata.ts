import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { withAiSlot } from "@kiwi/ai";
import { metadataPrompt } from "@kiwi/ai/prompts/metadata.prompt";

const METADATA_WORD_LIMIT = 250;

type MetadataGenerator = (args: {
    model: LanguageModel;
    prompt: string;
    temperature: number;
}) => Promise<{ text: string }>;

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

export async function buildMetadata(
    model: LanguageModel,
    documentName: string,
    excerpt: string | undefined,
    deps: {
        generate?: MetadataGenerator;
    } = {}
): Promise<string> {
    if (!excerpt) {
        return "";
    }

    const generate = deps.generate ?? generateText;
    const { text } = await withAiSlot("text", () =>
        generate({
            model,
            prompt: metadataPrompt(documentName, excerpt),
            temperature: 0.1,
        })
    );

    return text
        .replace(/[\r\n]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}
