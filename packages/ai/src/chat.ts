import type { ModelMessage } from "ai";
import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import type { ChatMessage, MessagePart, MessageToolPart } from "@kiwi/db/tables/chats";
import { toModelMessage } from "./index";
import { createChatPrompt } from "./prompts/chat.prompt";
import { listEntitiesTool, searchEntityTool } from "./tools/entity";
import { listFilesTool } from "./tools/file";
import {
    getNeighboursTool,
    getPathBetweenTool,
    getRelationshipsTool,
    searchRelationshipsTool,
} from "./tools/relationship";
import { getEntitySourcesTool, getRelationshipSourcesTool } from "./tools/source";
import { askQuestionTool } from "./tools/user";
import type { Adapter, EmbeddingAdapter } from "./index";
import type { ChatMessageMetadata, ChatUIMessage } from "./ui";
export type { ChatDataParts, ChatMessageMetadata, ChatUIMessage } from "./ui";
export {
    createCitationFenceStreamParser,
    prepareCitationFencesForModel,
    parseCitationFence,
    splitTextWithCitationFences,
    stringifyCitationFence,
    isResolvedCitationFence,
} from "./citation";
export type { CitationFence, ParsedCitationSegment, ResolvedCitationFence } from "./citation";

const CLIENT_TOOL_NAMES = new Set(["ask_clarifying_questions"]);

export function buildAdapter(
    type: "openai" | "azure" | "anthropic" | "openaiAPI",
    model: string,
    key: string,
    url?: string,
    resourceName?: string
): Adapter {
    switch (type) {
        case "openai":
            return { type, model, credentials: { apiKey: key } };
        case "anthropic":
            return { type, model, credentials: { apiKey: key } };
        case "azure":
            return {
                type,
                model,
                credentials: { resourceName: resourceName!, apiKey: key },
            };
        case "openaiAPI":
            return { type, model, credentials: { apiKey: key, url: url! } };
    }
}

export function buildEmbeddingAdapter(
    type: "openai" | "azure" | "openaiAPI",
    model: string,
    key: string,
    url?: string,
    resourceName?: string
): EmbeddingAdapter {
    switch (type) {
        case "openai":
            return { type, model, credentials: { apiKey: key } };
        case "azure":
            return {
                type,
                model,
                credentials: { resourceName: resourceName!, apiKey: key },
            };
        case "openaiAPI":
            return { type, model, credentials: { apiKey: key, url: url! } };
    }
}

export function buildChatTools(graphId: string, embeddingModel: EmbeddingModelV3) {
    return {
        list_files: listFilesTool(graphId),
        search_entities: searchEntityTool(graphId, embeddingModel),
        list_entities: listEntitiesTool(graphId),
        search_relationships: searchRelationshipsTool(graphId, embeddingModel),
        get_relationships: getRelationshipsTool(graphId),
        get_entity_neighbours: getNeighboursTool(graphId),
        get_path_between_entities: getPathBetweenTool(graphId),
        get_entity_sources: getEntitySourcesTool(graphId, embeddingModel),
        get_relationship_sources: getRelationshipSourcesTool(graphId, embeddingModel),
        ask_clarifying_questions: askQuestionTool(),
    };
}

export function createChatSystemPrompt(graphPrompt?: string) {
    return createChatPrompt(graphPrompt);
}

function toMessageToolPart(part: {
    type: string;
    toolCallId: string;
    toolName?: string;
    state: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
}): MessageToolPart {
    const toolName = part.type === "dynamic-tool" ? (part.toolName ?? "unknown_tool") : part.type.slice("tool-".length);
    const basePart: MessageToolPart = {
        type: "tool",
        toolCallId: part.toolCallId,
        toolName,
        execution: CLIENT_TOOL_NAMES.has(toolName) ? "client" : "server",
        status: "pending",
        args: part.input ?? null,
    };

    switch (part.state) {
        case "output-available":
            return {
                ...basePart,
                status: "completed",
                result: part.output,
            };
        case "output-error":
        case "output-denied":
            return {
                ...basePart,
                status: "failed",
                result: part.errorText ?? "Tool execution failed",
            };
        default:
            return basePart;
    }
}

function toMessageMetadataPart(metadata: ChatMessageMetadata): MessagePart | null {
    const { createdAt: _, ...storedMetadata } = metadata;
    const hasMetadata = Object.values(storedMetadata).some((value) => value !== undefined);
    if (!hasMetadata) {
        return null;
    }

    return {
        type: "metadata",
        metadata: storedMetadata,
    };
}

function isToolUIPartLike(
    part: ChatUIMessage["parts"][number]
): part is Extract<ChatUIMessage["parts"][number], { toolCallId: string; state: string }> {
    return "toolCallId" in part && "state" in part;
}

export function uiMessageToMessageParts(message: ChatUIMessage): MessagePart[] {
    const parts: MessagePart[] = [];

    for (const part of message.parts) {
        if (part.type === "text") {
            if (part.text) {
                parts.push({ type: "text", text: part.text });
            }
            continue;
        }

        if (part.type === "reasoning") {
            if (part.text) {
                parts.push({ type: "reasoning", text: part.text });
            }
            continue;
        }

        if (isToolUIPartLike(part)) {
            parts.push(
                toMessageToolPart({
                    type: part.type,
                    toolCallId: part.toolCallId,
                    toolName: "toolName" in part ? part.toolName : undefined,
                    state: part.state,
                    input: "input" in part ? part.input : undefined,
                    output: "output" in part ? part.output : undefined,
                    errorText: "errorText" in part ? part.errorText : undefined,
                })
            );
        }
    }

    const metadataPart = toMessageMetadataPart(message.metadata ?? {});
    if (metadataPart) {
        parts.push(metadataPart);
    }

    return parts;
}

function toToolUIPart(part: MessageToolPart) {
    const type = `tool-${part.toolName}` as `tool-${string}`;

    switch (part.status) {
        case "completed":
            return {
                type,
                toolCallId: part.toolCallId,
                state: "output-available" as const,
                input: part.args,
                output: part.result,
                providerExecuted: part.execution === "server",
            };
        case "failed":
            return {
                type,
                toolCallId: part.toolCallId,
                state: "output-error" as const,
                input: part.args,
                errorText: typeof part.result === "string" ? part.result : JSON.stringify(part.result ?? null),
                providerExecuted: part.execution === "server",
            };
        default:
            return {
                type,
                toolCallId: part.toolCallId,
                state: "input-available" as const,
                input: part.args,
                providerExecuted: part.execution === "server",
            };
    }
}

export function messagePartsToUIMessage(
    message: {
        id: string;
        role: "system" | "user" | "assistant";
        parts: MessagePart[];
        createdAt?: Date | null;
    },
    fallbackMetadata?: ChatMessageMetadata
): ChatUIMessage {
    const metadataPart = message.parts.find(
        (part): part is Extract<MessagePart, { type: "metadata" }> => part.type === "metadata"
    );
    const uiParts: ChatUIMessage["parts"] = [];

    for (const part of message.parts) {
        switch (part.type) {
            case "text":
                uiParts.push({ type: "text", text: part.text });
                break;
            case "reasoning":
                uiParts.push({ type: "reasoning", text: part.text });
                break;
            case "tool":
                uiParts.push(toToolUIPart(part) as ChatUIMessage["parts"][number]);
                break;
            case "metadata":
                break;
        }
    }

    const metadata = {
        createdAt: message.createdAt?.toISOString(),
        ...(fallbackMetadata ?? {}),
        ...(metadataPart?.metadata ?? {}),
    } satisfies ChatMessageMetadata;

    return {
        id: message.id,
        role: message.role,
        metadata,
        parts: uiParts,
    };
}

export function toUIMessage(
    message: Pick<
        ChatMessage,
        | "id"
        | "role"
        | "parts"
        | "createdAt"
        | "tokensPerSecond"
        | "timeToFirstToken"
        | "inputTokens"
        | "outputTokens"
        | "totalTokens"
    >
): ChatUIMessage {
    return messagePartsToUIMessage(
        {
            id: message.id,
            role: message.role,
            parts: message.parts,
            createdAt: message.createdAt,
        },
        {
            inputTokens: message.inputTokens ?? undefined,
            outputTokens: message.outputTokens ?? undefined,
            totalTokens: message.totalTokens ?? undefined,
            tokensPerSecond: message.tokensPerSecond ?? undefined,
            timeToFirstToken: message.timeToFirstToken ?? undefined,
        }
    );
}

export function uiMessagesToModelMessages(messages: ChatUIMessage[]): ModelMessage[] {
    return messages.flatMap((message) =>
        toModelMessage({
            id: message.id,
            chatId: "",
            status: "completed",
            role: message.role,
            parts: uiMessageToMessageParts(message),
            tokensPerSecond: null,
            timeToFirstToken: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            createdAt: null,
            updatedAt: null,
        })
    );
}
