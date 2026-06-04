import {
    createCitationFenceStreamParser,
    getProviderOptions,
    stringifyCitationFence,
    type ChatUIMessage,
    type ResolvedCitationFence,
} from "@kiwi/ai";
import type { MessagePart } from "@kiwi/contracts/chat";
import type { Client } from "@kiwi/ai";
import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    generateText,
    smoothStream,
    stepCountIs,
    streamText,
    type ModelMessage,
    type ToolSet,
} from "ai";
import { env } from "../env";
import {
    getFinishMetadata,
    isContextOverflowError,
    startsAssistantOutput,
    toolPart,
    toAssistantReply,
    touchChat,
    updateAssistantMessage,
} from "./chat";
import { startChatTitleGeneration } from "./chat-title";

export type ChatReplyContext = {
    systemPrompt: string;
    contextMessages: ModelMessage[];
};

export type StartedChatReply = ChatReplyContext & {
    chatId: string;
    assistantId: string;
    client: Client & {
        text: NonNullable<Client["text"]>;
    };
    tools: ToolSet;
    isNewChat: boolean;
    titleMessages: ChatUIMessage[];
    refreshAfterCompaction: () => Promise<ChatReplyContext>;
    resolveCitation: (sourceId: string) => Promise<ResolvedCitationFence | null>;
};

function upsertToolPart(parts: MessagePart[], next: MessagePart) {
    if (next.type !== "tool") {
        parts.push(next);
        return;
    }

    const idx = parts.findIndex((part) => part.type === "tool" && part.toolCallId === next.toolCallId);
    if (idx === -1) {
        parts.push(next);
        return;
    }

    parts[idx] = next;
}

function addCitationFileId(fileIds: Set<string>, citation: ResolvedCitationFence) {
    const citationFileId = citation.fileId ?? citation.fileKey;
    if (citationFileId) {
        fileIds.add(citationFileId);
    }
}

async function appendResolvedCitations(options: {
    text: string;
    citationFileIds: Set<string>;
    resolveCitation: StartedChatReply["resolveCitation"];
}) {
    const parser = createCitationFenceStreamParser();
    const segments = [...parser.push(options.text), ...parser.flush()];
    let text = "";

    for (const segment of segments) {
        if (segment.type === "text") {
            text += segment.text;
            continue;
        }

        const citation = await options.resolveCitation(segment.citation.sourceId);
        if (citation) {
            addCitationFileId(options.citationFileIds, citation);
            text += stringifyCitationFence(citation);
        }
    }

    return text;
}

async function buildAssistantPartsFromContent(options: {
    content: Awaited<ReturnType<typeof generateText>>["content"];
    citationFileIds: Set<string>;
    resolveCitation: StartedChatReply["resolveCitation"];
}) {
    const parts: MessagePart[] = [];

    for (const contentPart of options.content) {
        switch (contentPart.type) {
            case "text": {
                const text = await appendResolvedCitations({
                    text: contentPart.text,
                    citationFileIds: options.citationFileIds,
                    resolveCitation: options.resolveCitation,
                });
                if (text.length > 0) {
                    parts.push({ type: "text", text });
                }
                break;
            }
            case "reasoning":
                parts.push({ type: "reasoning", text: contentPart.text });
                break;
            case "tool-call":
                upsertToolPart(parts, toolPart(contentPart, "pending"));
                break;
            case "tool-result":
                upsertToolPart(parts, toolPart(contentPart, "completed", { value: contentPart.output }));
                break;
            case "tool-error":
                upsertToolPart(
                    parts,
                    toolPart(contentPart, "failed", {
                        value:
                            typeof contentPart.error === "string"
                                ? contentPart.error
                                : JSON.stringify(contentPart.error),
                    })
                );
                break;
        }
    }

    return parts;
}

function startGeneratedTitle(reply: StartedChatReply) {
    startChatTitleGeneration({
        chatId: reply.chatId,
        messages: reply.titleMessages,
        client: reply.client,
        isNewChat: reply.isNewChat,
    });
}

export async function runChatCompletion(reply: StartedChatReply) {
    startGeneratedTitle(reply);

    const startedAt = Date.now();
    const citationFileIds = new Set<string>();
    let activeContextMessages = reply.contextMessages;
    let activeSystemPrompt = reply.systemPrompt;
    let retriedAfterCompaction = false;

    const runGeneration = () =>
        generateText({
            model: reply.client.text,
            messages: activeContextMessages,
            system: activeSystemPrompt,
            tools: reply.tools,
            temperature: 0.3,
            stopWhen: stepCountIs(50),
            providerOptions: getProviderOptions({ thinking: "medium" }),
        });

    let result;
    try {
        result = await runGeneration();
    } catch (error) {
        if (!retriedAfterCompaction && isContextOverflowError(error)) {
            retriedAfterCompaction = true;
            let refreshed;
            try {
                refreshed = await reply.refreshAfterCompaction();
            } catch (compactionError) {
                await updateAssistantMessage(reply.assistantId, [], "failed");
                throw compactionError;
            }
            activeContextMessages = refreshed.contextMessages;
            activeSystemPrompt = refreshed.systemPrompt;
            try {
                result = await runGeneration();
            } catch (retryError) {
                await updateAssistantMessage(reply.assistantId, [], "failed");
                throw retryError;
            }
        } else {
            await updateAssistantMessage(reply.assistantId, [], "failed");
            throw error;
        }
    }

    const parts = await buildAssistantPartsFromContent({
        content: result.content,
        citationFileIds,
        resolveCitation: reply.resolveCitation,
    });
    const finishMetadata = getFinishMetadata({
        startedAt,
        firstOutputAt: startedAt,
        totalTokens: result.totalUsage.totalTokens,
        inputTokens: result.totalUsage.inputTokens,
        outputTokens: result.totalUsage.outputTokens,
        modelId: env.AI_TEXT_MODEL,
        usedFileCount: citationFileIds.size,
    });
    parts.push({ type: "metadata", metadata: finishMetadata });

    await updateAssistantMessage(reply.assistantId, parts, "completed", finishMetadata);
    await touchChat(reply.chatId);

    return {
        id: reply.chatId,
        message: toAssistantReply(reply.assistantId, parts, finishMetadata),
    };
}

export function createChatStreamResponse(reply: StartedChatReply) {
    startGeneratedTitle(reply);

    const startedAt = Date.now();
    let firstOutputAt: number | null = null;
    let hasStreamedAssistantOutput = false;
    const assistantParts: MessagePart[] = [];
    const citationFileIds = new Set<string>();
    const reasoningBuffers = new Map<string, string>();
    const toolDynamicFlags = new Map<string, boolean>();

    const pinToolDynamic = (toolCallId: string, incoming: boolean | undefined): boolean => {
        const existing = toolDynamicFlags.get(toolCallId);
        if (existing !== undefined) return existing;
        const value = Boolean(incoming);
        toolDynamicFlags.set(toolCallId, value);
        return value;
    };

    const stream = createUIMessageStream<ChatUIMessage>({
        execute: async ({ writer }) => {
            writer.write({
                type: "start",
                messageId: reply.assistantId,
                messageMetadata: {
                    createdAt: new Date(startedAt).toISOString(),
                    modelId: env.AI_TEXT_MODEL,
                },
            });

            const textParsers = new Map<string, ReturnType<typeof createCitationFenceStreamParser>>();
            type ActiveUIText = { uiId: string; buffer: string };
            const activeUITexts = new Map<string, ActiveUIText>();
            let uiTextBlockCounter = 0;
            let activeContextMessages = reply.contextMessages;
            let activeSystemPrompt = reply.systemPrompt;
            let retriedAfterCompaction = false;
            let discardAssistantPartsOnFailure = false;

            const createUITextId = (modelPartId: string) => `${modelPartId}::${uiTextBlockCounter++}`;

            const openUIText = (modelPartId: string): ActiveUIText => {
                const existing = activeUITexts.get(modelPartId);
                if (existing) return existing;
                const uiId = createUITextId(modelPartId);
                const active: ActiveUIText = { uiId, buffer: "" };
                activeUITexts.set(modelPartId, active);
                writer.write({ type: "text-start", id: uiId });
                return active;
            };

            const closeUIText = async (modelPartId: string) => {
                const active = activeUITexts.get(modelPartId);
                if (!active) return;
                if (active.buffer.length > 0) {
                    assistantParts.push({ type: "text", text: active.buffer });
                    await updateAssistantMessage(reply.assistantId, assistantParts, "pending");
                }
                writer.write({ type: "text-end", id: active.uiId });
                activeUITexts.delete(modelPartId);
            };

            const appendText = (modelPartId: string, text: string) => {
                if (text.length === 0) return;
                const active = openUIText(modelPartId);
                active.buffer += text;
                writer.write({
                    type: "text-delta",
                    id: active.uiId,
                    delta: text,
                });
            };

            const emitCitationFence = async (modelPartId: string, citationId: string) => {
                const citation = await reply.resolveCitation(citationId);
                if (!citation) {
                    return;
                }

                addCitationFileId(citationFileIds, citation);
                appendText(modelPartId, stringifyCitationFence(citation));
            };

            const createResult = () =>
                streamText({
                    model: reply.client.text,
                    messages: activeContextMessages,
                    system: activeSystemPrompt,
                    tools: reply.tools,
                    temperature: 0.3,
                    stopWhen: stepCountIs(50),
                    experimental_transform: smoothStream({
                        delayInMs: 20,
                        chunking: "word",
                    }),
                    providerOptions: getProviderOptions({ thinking: "medium" }),
                });

            const processResult = async (result: ReturnType<typeof streamText>) => {
                let retryRequested = false;

                generationStream: for await (const part of result.fullStream) {
                    const assistantOutputStarted = startsAssistantOutput(part.type);
                    if (assistantOutputStarted && firstOutputAt === null) {
                        firstOutputAt = Date.now();
                    }
                    if (assistantOutputStarted) {
                        hasStreamedAssistantOutput = true;
                    }

                    switch (part.type) {
                        case "text-start":
                            textParsers.set(part.id, createCitationFenceStreamParser());
                            break;
                        case "text-delta": {
                            const parser = textParsers.get(part.id);
                            if (!parser) break;

                            for (const segment of parser.push(part.text)) {
                                if (segment.type === "text") {
                                    appendText(part.id, segment.text);
                                    continue;
                                }

                                await emitCitationFence(part.id, segment.citation.sourceId);
                            }
                            break;
                        }
                        case "text-end": {
                            const parser = textParsers.get(part.id);
                            if (parser) {
                                for (const segment of parser.flush()) {
                                    if (segment.type === "text") {
                                        appendText(part.id, segment.text);
                                        continue;
                                    }

                                    await emitCitationFence(part.id, segment.citation.sourceId);
                                }
                            }

                            await closeUIText(part.id);
                            textParsers.delete(part.id);
                            break;
                        }
                        case "reasoning-start":
                            reasoningBuffers.set(part.id, "");
                            writer.write({ type: "reasoning-start", id: part.id });
                            break;
                        case "reasoning-delta":
                            reasoningBuffers.set(part.id, `${reasoningBuffers.get(part.id) ?? ""}${part.text}`);
                            writer.write({
                                type: "reasoning-delta",
                                id: part.id,
                                delta: part.text,
                            });
                            break;
                        case "reasoning-end": {
                            const reasoning = reasoningBuffers.get(part.id) ?? "";
                            if (reasoning.length > 0) {
                                assistantParts.push({
                                    type: "reasoning",
                                    text: reasoning,
                                });
                                await updateAssistantMessage(reply.assistantId, assistantParts, "pending");
                            }
                            writer.write({ type: "reasoning-end", id: part.id });
                            reasoningBuffers.delete(part.id);
                            break;
                        }
                        case "tool-input-start":
                            writer.write({
                                type: "tool-input-start",
                                toolCallId: part.id,
                                toolName: part.toolName,
                                providerExecuted: part.providerExecuted,
                                dynamic: pinToolDynamic(part.id, part.dynamic),
                                title: part.title,
                            });
                            break;
                        case "tool-input-delta":
                            writer.write({
                                type: "tool-input-delta",
                                toolCallId: part.id,
                                inputTextDelta: part.delta,
                            });
                            break;
                        case "tool-call":
                            upsertToolPart(assistantParts, toolPart(part, "pending"));
                            await updateAssistantMessage(reply.assistantId, assistantParts, "pending");
                            writer.write({
                                type: "tool-input-available",
                                toolCallId: part.toolCallId,
                                toolName: part.toolName,
                                input: part.input,
                                providerExecuted: part.providerExecuted,
                                dynamic: pinToolDynamic(part.toolCallId, part.dynamic),
                                title: part.title,
                            });
                            break;
                        case "tool-result":
                            upsertToolPart(assistantParts, toolPart(part, "completed", { value: part.output }));
                            await updateAssistantMessage(reply.assistantId, assistantParts, "pending");
                            writer.write({
                                type: "tool-output-available",
                                toolCallId: part.toolCallId,
                                output: part.output,
                                providerExecuted: part.providerExecuted,
                                dynamic: pinToolDynamic(part.toolCallId, part.dynamic),
                                preliminary: part.preliminary,
                            });
                            break;
                        case "tool-error": {
                            const errorText =
                                typeof part.error === "string" ? part.error : JSON.stringify(part.error ?? null);
                            upsertToolPart(assistantParts, toolPart(part, "failed", { value: errorText }));
                            await updateAssistantMessage(reply.assistantId, assistantParts, "pending");
                            writer.write({
                                type: "tool-output-error",
                                toolCallId: part.toolCallId,
                                errorText,
                                providerExecuted: part.providerExecuted,
                                dynamic: pinToolDynamic(part.toolCallId, part.dynamic),
                            });
                            break;
                        }
                        case "tool-output-denied":
                            writer.write({
                                type: "tool-output-denied",
                                toolCallId: part.toolCallId,
                            });
                            break;
                        case "tool-approval-request":
                            writer.write({
                                type: "tool-approval-request",
                                approvalId: part.approvalId,
                                toolCallId: part.toolCall.toolCallId,
                            });
                            break;
                        case "start-step":
                            writer.write({
                                type: "data-step",
                                data: { name: "thinking" },
                                transient: true,
                            });
                            break;
                        case "finish-step":
                            writer.write({ type: "finish-step" });
                            break;
                        case "finish": {
                            const finishMetadata = getFinishMetadata({
                                startedAt,
                                firstOutputAt,
                                totalTokens: part.totalUsage.totalTokens,
                                inputTokens: part.totalUsage.inputTokens,
                                outputTokens: part.totalUsage.outputTokens,
                                modelId: env.AI_TEXT_MODEL,
                                usedFileCount: citationFileIds.size,
                            });
                            assistantParts.push({
                                type: "metadata",
                                metadata: finishMetadata,
                            });
                            await updateAssistantMessage(
                                reply.assistantId,
                                assistantParts,
                                "completed",
                                finishMetadata
                            );
                            await touchChat(reply.chatId);
                            writer.write({
                                type: "finish",
                                finishReason: part.finishReason,
                                messageMetadata: finishMetadata,
                            });
                            break;
                        }
                        case "error": {
                            if (
                                !retriedAfterCompaction &&
                                !hasStreamedAssistantOutput &&
                                isContextOverflowError(part.error)
                            ) {
                                retryRequested = true;
                                break generationStream;
                            }

                            const errorText = part.error instanceof Error ? part.error.message : String(part.error);
                            await updateAssistantMessage(reply.assistantId, assistantParts, "failed");
                            writer.write({ type: "error", errorText });
                            break;
                        }
                    }
                }

                return retryRequested;
            };

            try {
                generationAttempt: while (true) {
                    let retryRequested = false;

                    try {
                        retryRequested = await processResult(createResult());
                    } catch (error) {
                        if (!retriedAfterCompaction && !hasStreamedAssistantOutput && isContextOverflowError(error)) {
                            retryRequested = true;
                        } else {
                            throw error;
                        }
                    }

                    if (!retryRequested) {
                        break generationAttempt;
                    }

                    retriedAfterCompaction = true;
                    let refreshed;
                    try {
                        refreshed = await reply.refreshAfterCompaction();
                    } catch (compactionError) {
                        discardAssistantPartsOnFailure = true;
                        throw compactionError;
                    }
                    activeContextMessages = refreshed.contextMessages;
                    activeSystemPrompt = refreshed.systemPrompt;
                }
            } catch (error) {
                if (!discardAssistantPartsOnFailure) {
                    for (const modelPartId of [...activeUITexts.keys()]) {
                        await closeUIText(modelPartId);
                    }
                }
                const errorText = error instanceof Error ? error.message : "Unknown stream error";
                await updateAssistantMessage(
                    reply.assistantId,
                    discardAssistantPartsOnFailure ? [] : assistantParts,
                    "failed"
                );
                writer.write({ type: "error", errorText });
                writer.write({ type: "finish", finishReason: "error" });
            }
        },
    });

    return createUIMessageStreamResponse({ stream });
}
