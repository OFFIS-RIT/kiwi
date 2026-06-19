import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText, stepCountIs } from "ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withAiSlotEffect, type AiSlotError } from "../concurrency";
import { prependPromptGuidance, type ScopedPromptGuidance } from "../prompts/guidance.prompt";

export type RunMcpResearchOptions<E = never> = {
    model: LanguageModelV3;
    system?: string;
    question: string;
    tools?: Parameters<typeof generateText>[0]["tools"];
    promptGuidance?: ScopedPromptGuidance;
    temperature?: number;
    maxSteps?: number;
    providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
    transformAnswer?: (text: string) => Effect.Effect<string, E>;
};

export type McpResearchRunResult = {
    rawAnswer: string;
    answer: string;
};

export class McpResearchEmptyAnswerError extends Schema.TaggedErrorClass<McpResearchEmptyAnswerError>()(
    "McpResearchEmptyAnswerError",
    {
        message: Schema.String,
    }
) {}

function extractFinalText(content: Awaited<ReturnType<typeof generateText>>["content"]) {
    return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export function runMcpResearch<E = never>(
    options: RunMcpResearchOptions<E>
): Effect.Effect<McpResearchRunResult, AiSlotError | McpResearchEmptyAnswerError | E> {
    return Effect.gen(function* () {
        const result = yield* withAiSlotEffect("text", (signal) =>
            generateText({
                model: options.model,
                messages: [
                    {
                        role: "user",
                        content: prependPromptGuidance(options.question, options.promptGuidance),
                    },
                ],
                system: options.system,
                tools: options.tools,
                temperature: options.temperature ?? 0.3,
                stopWhen: stepCountIs(options.maxSteps ?? 50),
                providerOptions: options.providerOptions,
                abortSignal: signal,
            })
        );

        const rawAnswer = extractFinalText(result.content);
        if (rawAnswer.trim().length === 0) {
            return yield* new McpResearchEmptyAnswerError({
                message: "Research completed without a final text answer.",
            });
        }

        const answer = options.transformAnswer ? yield* options.transformAnswer(rawAnswer) : rawAnswer;

        return {
            rawAnswer,
            answer,
        };
    });
}
