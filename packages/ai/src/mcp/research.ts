import type { LanguageModelV3 } from "@ai-sdk/provider";
import { generateText, stepCountIs } from "ai";

export type RunMcpResearchOptions = {
    model: LanguageModelV3;
    system?: string;
    question: string;
    tools?: Parameters<typeof generateText>[0]["tools"];
    temperature?: number;
    maxSteps?: number;
    providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
    transformAnswer?: (text: string) => Promise<string>;
};

export type McpResearchRunResult = {
    rawAnswer: string;
    answer: string;
};

function extractFinalText(content: Awaited<ReturnType<typeof generateText>>["content"]) {
    return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export async function runMcpResearch(options: RunMcpResearchOptions): Promise<McpResearchRunResult> {
    const result = await generateText({
        model: options.model,
        messages: [
            {
                role: "user",
                content: options.question,
            },
        ],
        system: options.system,
        tools: options.tools,
        temperature: options.temperature ?? 0.3,
        stopWhen: stepCountIs(options.maxSteps ?? 50),
        providerOptions: options.providerOptions,
    });

    const rawAnswer = extractFinalText(result.content);
    const answer = options.transformAnswer ? await options.transformAnswer(rawAnswer) : rawAnswer;

    return {
        rawAnswer,
        answer,
    };
}
