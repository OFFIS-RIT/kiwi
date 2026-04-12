import { createAnthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI, type OpenAILanguageModelChatOptions } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModelV3, JSONValue, LanguageModelV3 } from "@ai-sdk/provider";
import type { ChatMessage, MessagePart, MessageToolPart } from "@kiwi/db/tables/chats";
import type { ModelMessage } from "ai";
import { get_encoding, type TiktokenEncoding } from "tiktoken";
export * from "./concurrency";

type OpenAICredentials = {
    apiKey: string;
};

type OpenAIApiCredentials = {
    apiKey: string;
    url: string;
};

type AnthropicCredentials = {
    apiKey: string;
};

type AzureCredentials = {
    resourceName: string;
    apiKey: string;
};

type OpenAIAdapter = {
    type: "openai";
    model: string;
    credentials?: OpenAICredentials;
};

type OpenAIApiAdapter = {
    type: "openaiAPI";
    model: string;
    credentials?: OpenAIApiCredentials;
};

type AnthropicAdapter = {
    type: "anthropic";
    model: string;
    credentials?: AnthropicCredentials;
};

type AzureAdapter = {
    type: "azure";
    model: string;
    credentials?: AzureCredentials;
};

/** Adapter configuration for a single AI capability. */
export type Adapter = OpenAIAdapter | OpenAIApiAdapter | AnthropicAdapter | AzureAdapter;

/** Embedding adapter – excludes Anthropic (no embedding models). */
export type EmbeddingAdapter = Exclude<Adapter, AnthropicAdapter>;

type AssistantContent = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
type ToolContent = Extract<ModelMessage, { role: "tool" }>["content"];
type ToolResultPart = Extract<ToolContent[number], { type: "tool-result" }>;
type ToolResultOutput = ToolResultPart["output"];

const CLIENT_TOOL_NAMES = new Set(["ask_clarifying_questions"]);

function createProvider(adapter: Adapter) {
    switch (adapter.type) {
        case "openai":
            return createOpenAI({
                apiKey: adapter.credentials?.apiKey ?? process.env.OPENAI_API_KEY ?? "",
            });
        case "openaiAPI":
            return createOpenAICompatible({
                name: "openaiAPI",
                apiKey: adapter.credentials?.apiKey ?? process.env.OPENAI_API_KEY ?? "",
                baseURL: adapter.credentials?.url ?? process.env.OPENAI_API_URL ?? "https://api.openai.com/v1",
                includeUsage: true,
                supportsStructuredOutputs: true,
            });
        case "anthropic":
            return createAnthropic({
                apiKey: adapter.credentials?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
            });
        case "azure":
            return createAzure({
                resourceName: adapter.credentials?.resourceName ?? process.env.AZURE_RESOURCE_NAME ?? "",
                apiKey: adapter.credentials?.apiKey ?? process.env.AZURE_API_KEY ?? "",
            });
    }
}

export type ClientConfig = {
    text?: Adapter;
    embedding?: EmbeddingAdapter;
    image?: Adapter;
    audio?: Adapter;
};

export type Client = {
    text?: LanguageModelV3;
    embedding?: EmbeddingModelV3;
    image?: LanguageModelV3;
    audio?: LanguageModelV3;
};

/**
 * Create a pre-configured AI client with separate adapters per capability.
 *
 * @example
 * ```ts
 * const client = getClient({
 *   text:      { type: "anthropic", model: "claude-sonnet-4-20250514", credentials: { apiKey: "..." } },
 *   embedding: { type: "openai",    model: "text-embedding-3-small",   credentials: { apiKey: "..." } },
 *   image:     { type: "openai",    model: "gpt-4o",                   credentials: { apiKey: "..." } },
 * });
 *
 * generateText({ model: client.text! });
 * embed({ model: client.embedding! });
 * generateText({ model: client.image! });
 * ```
 */
export function getClient(config: ClientConfig): Client {
    return {
        text: config.text ? createProvider(config.text).languageModel(config.text.model) : undefined,
        embedding: config.embedding
            ? createProvider(config.embedding).embeddingModel(config.embedding.model)
            : undefined,
        image: config.image ? createProvider(config.image).languageModel(config.image.model) : undefined,
        audio: config.audio ? createProvider(config.audio).languageModel(config.audio.model) : undefined,
    };
}

export type ProviderOptions = {
    thinking?: "none" | "low" | "medium" | "high";
};

export function getProviderOptions(options: ProviderOptions) {
    if (!options.thinking) {
        return undefined;
    }

    return {
        openAI: {
            reasoningEffort: options.thinking ? options.thinking : "none",
            parallelToolCalls: true,
        } satisfies OpenAILanguageModelChatOptions,
        anthropic: {
            thinking: {
                type: options.thinking ? "adaptive" : "disabled",
            },
            effort: options.thinking && options.thinking !== "none" ? options.thinking : undefined,
            toolStreaming: true,
        } satisfies AnthropicLanguageModelOptions,
        openaiAPI: {
            thinking: options.thinking ? options.thinking : "none",
            parallelToolCalls: true,
        },
        azure: {
            reasoningEffort: options.thinking ? options.thinking : "none",
            parallelToolCalls: true,
        },
    };
}

export function estimateToken(text: string, encoding?: TiktokenEncoding): number {
    const encoder = get_encoding(encoding || "o200k_base");
    const tokens = encoder.encode(text);
    encoder.free();

    return tokens.length;
}

function toToolResultOutput(toolName: string, status: "completed" | "failed", result: unknown): ToolResultOutput {
    if (status === "failed") {
        return typeof result === "string"
            ? { type: "error-text", value: result }
            : { type: "error-json", value: (result ?? { error: `Tool ${toolName} failed` }) as JSONValue };
    }

    return typeof result === "string"
        ? { type: "text", value: result }
        : { type: "json", value: (result ?? null) as JSONValue };
}

function fromToolResultOutput(output: ToolResultOutput): Pick<MessageToolPart, "status" | "result"> {
    switch (output.type) {
        case "error-text":
            return { status: "failed", result: output.value };
        case "error-json":
            return { status: "failed", result: output.value };
        case "execution-denied":
            return { status: "failed", result: output.reason ?? "Tool execution denied" };
        case "text":
            return { status: "completed", result: output.value };
        case "json":
            return { status: "completed", result: output.value };
        case "content":
            return { status: "completed", result: output.value };
    }
}

function getOrCreateToolPart(parts: MessagePart[], toolCallId: string, toolName: string): MessageToolPart {
    const existingPart = parts.find(
        (part): part is MessageToolPart => part.type === "tool" && part.toolCallId === toolCallId
    );

    if (existingPart) {
        return existingPart;
    }

    const toolPart: MessageToolPart = {
        type: "tool",
        toolCallId,
        toolName,
        execution: CLIENT_TOOL_NAMES.has(toolName) ? "client" : "server",
        status: "pending",
        args: null,
    };

    parts.push(toolPart);

    return toolPart;
}

export function toChatMessageParts(message: ModelMessage): MessagePart[] {
    switch (message.role) {
        case "user":
        case "system":
            if (typeof message.content === "string") {
                return message.content ? [{ type: "text", text: message.content }] : [];
            }

            return message.content.flatMap((part) =>
                part.type === "text" && part.text ? [{ type: "text", text: part.text }] : []
            );
        case "assistant": {
            if (typeof message.content === "string") {
                return message.content ? [{ type: "text", text: message.content }] : [];
            }

            const parts: MessagePart[] = [];

            for (const part of message.content) {
                switch (part.type) {
                    case "text":
                        if (part.text) {
                            parts.push({ type: "text", text: part.text });
                        }
                        break;
                    case "reasoning":
                        if (part.text) {
                            parts.push({ type: "reasoning", text: part.text });
                        }
                        break;
                    case "tool-call": {
                        const toolPart = getOrCreateToolPart(parts, part.toolCallId, part.toolName);
                        toolPart.args = part.input;
                        break;
                    }
                    case "tool-result": {
                        const toolPart = getOrCreateToolPart(parts, part.toolCallId, part.toolName);
                        const result = fromToolResultOutput(part.output);
                        toolPart.status = result.status;
                        toolPart.result = result.result;
                        break;
                    }
                }
            }

            return parts;
        }
        case "tool": {
            const parts: MessagePart[] = [];

            for (const part of message.content) {
                if (part.type !== "tool-result") {
                    continue;
                }

                const result = fromToolResultOutput(part.output);
                parts.push({
                    type: "tool",
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    execution: CLIENT_TOOL_NAMES.has(part.toolName) ? "client" : "server",
                    status: result.status,
                    args: null,
                    result: result.result,
                });
            }

            return parts;
        }
    }
}

export function toModelMessage(message: ChatMessage): ModelMessage[] {
    switch (message.role) {
        case "user": {
            const content = message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");

            return content ? [{ role: "user", content }] : [];
        }
        case "system": {
            const content = message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");

            return content ? [{ role: "system", content }] : [];
        }
        case "assistant": {
            const messages: ModelMessage[] = [];
            const content: AssistantContent = [];
            const toolResults: ToolContent = [];

            for (const part of message.parts) {
                switch (part.type) {
                    case "text":
                        if (part.text) {
                            content.push({ type: "text", text: part.text });
                        }
                        break;
                    case "reasoning":
                        if (part.text) {
                            content.push({ type: "reasoning", text: part.text });
                        }
                        break;
                    case "tool": {
                        content.push({
                            type: "tool-call",
                            toolCallId: part.toolCallId,
                            toolName: part.toolName,
                            input: part.args,
                        });

                        if (part.status === "completed" || part.status === "failed") {
                            toolResults.push({
                                type: "tool-result",
                                toolCallId: part.toolCallId,
                                toolName: part.toolName,
                                output: toToolResultOutput(part.toolName, part.status, part.result),
                            });
                        }

                        break;
                    }
                    case "citation":
                    case "metadata":
                        break;
                }
            }

            if (content.length > 0) {
                messages.push({ role: "assistant", content });
            }

            if (toolResults.length > 0) {
                messages.push({ role: "tool", content: toolResults });
            }

            return messages;
        }
    }
}

export * from "./ui";
export * from "./chat";
