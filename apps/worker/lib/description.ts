import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { descriptionPromp, updateDescriptionPromp } from "@kiwi/ai/prompts/description.prompt";

export function normalizeDescription(text: string): string {
    return text
        .replace(/[\r\n]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

export async function buildDescription(
    model: LanguageModel,
    name: string,
    sourceDescriptions: string[],
    currentDescription: string | undefined
): Promise<string> {
    if (sourceDescriptions.length === 0) return currentDescription || "";

    const prompt = currentDescription
        ? updateDescriptionPromp(name, sourceDescriptions, currentDescription)
        : descriptionPromp(name, sourceDescriptions);

    const { text } = await generateText({ model, prompt });
    return normalizeDescription(text);
}
