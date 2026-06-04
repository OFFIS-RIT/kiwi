import { createPromptGuidancePrompt, type ScopedPromptGuidance } from "@kiwi/ai/prompts/guidance.prompt";
import type { ModelMessage } from "ai";

export type { ScopedPromptGuidance };

export function createPromptGuidanceMessage(guidance?: ScopedPromptGuidance): ModelMessage | null {
    const content = createPromptGuidancePrompt(guidance);
    if (!content) {
        return null;
    }

    return {
        role: "user",
        content,
    };
}

export function insertPromptGuidanceMessage(messages: ModelMessage[], guidance?: ScopedPromptGuidance) {
    const guidanceMessage = createPromptGuidanceMessage(guidance);
    if (!guidanceMessage) {
        return messages;
    }

    let latestUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") {
            latestUserIndex = index;
            break;
        }
    }

    if (latestUserIndex === -1) {
        return messages;
    }

    return [...messages.slice(0, latestUserIndex), guidanceMessage, ...messages.slice(latestUserIndex)];
}
