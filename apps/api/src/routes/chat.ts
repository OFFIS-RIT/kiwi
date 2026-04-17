import {
    createChatSystemPrompt,
    createCitationFenceStreamParser,
    getProviderOptions,
    type ChatUIMessage,
    uiMessagesToModelMessages,
} from "@kiwi/ai";
import { db } from "@kiwi/db";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { chatTable, type MessagePart } from "@kiwi/db/tables/chats";
import { Elysia, t } from "elysia";
import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    generateText,
    smoothStream,
    stepCountIs,
    streamText,
} from "ai";
import { env } from "../env";
import {
    enrichCitation,
    getFinishMetadata,
    listChats,
    loadChatHistory,
    mapChatError,
    startReply,
    toolPart,
    toAssistantReply,
    touchChat,
    updateAssistantMessage,
    type ChatRequest,
} from "../lib/chat";
import { assertCanViewGraph } from "../lib/graph-access";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

const requestBodySchema = t.Object({
    id: t.String(),
    messages: t.Array(t.Any()),
});

/**
 * Replace the existing tool entry that shares `toolCallId` in-place, or append
 * when no prior entry exists. The AI SDK collapses `tool-call` →
 * `tool-result`/`tool-error` events into a single UI part keyed by
 * `toolCallId`, so the persisted `MessagePart[]` has to mirror that contract.
 * Without this, reloading a chat would resurrect each tool twice (pending →
 * spinner AND completed/failed → check/cross).
 */
function upsertToolPart(parts: MessagePart[], next: MessagePart) {
    if (next.type !== "tool") {
        parts.push(next);
        return;
    }
    const idx = parts.findIndex((p) => p.type === "tool" && p.toolCallId === next.toolCallId);
    if (idx === -1) {
        parts.push(next);
        return;
    }
    parts[idx] = next;
}

export const chatRoute = new Elysia()
    .use(authMiddleware)
    .get(
        "/chat/:id",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const chatsResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);
                return listChats(user.id, params.id);
            });

            if (chatsResult.isErr()) {
                return mapChatError(status, chatsResult.error);
            }

            return status(200, successResponse(chatsResult.value));
        },
        {
            beforeHandle: requirePermissions({ graph: ["view"] }),
            params: t.Object({
                id: t.String(),
            }),
        }
    )
    .get(
        "/chat/:id/:chatId",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const historyResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);
                return loadChatHistory(user.id, params.id, params.chatId);
            });

            if (historyResult.isErr()) {
                return mapChatError(status, historyResult.error);
            }

            return status(200, successResponse(historyResult.value));
        },
        {
            beforeHandle: requirePermissions({ graph: ["view"] }),
            params: t.Object({
                id: t.String(),
                chatId: t.String(),
            }),
        }
    )
    .delete(
        "/chat/:id/:chatId",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const deleteResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);
                const history = await loadChatHistory(user.id, params.id, params.chatId);
                await db.delete(chatTable).where(eq(chatTable.id, history.id));
            });

            if (deleteResult.isErr()) {
                return mapChatError(status, deleteResult.error);
            }

            return status(204, null);
        },
        {
            beforeHandle: requirePermissions({ graph: ["view"] }),
            params: t.Object({
                id: t.String(),
                chatId: t.String(),
            }),
        }
    )
    .post(
        "/chat/:id",
        async ({ params, body, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const replyResult = await Result.tryPromise(async () => {
                const request = body as ChatRequest;
                await assertCanViewGraph(user, params.id);
                const { assistantId, client, tools, prompt } = await startReply(user.id, params.id, request);

                const startedAt = Date.now();
                const result = await generateText({
                    model: client.text!,
                    messages: uiMessagesToModelMessages(request.messages),
                    system: createChatSystemPrompt(prompt),
                    tools,
                    temperature: 0.3,
                    stopWhen: stepCountIs(50),
                    providerOptions: getProviderOptions({ thinking: "medium" }),
                });

                const parts: MessagePart[] = [];
                for (const contentPart of result.content) {
                    switch (contentPart.type) {
                        case "text": {
                            const parser = createCitationFenceStreamParser();
                            const segments = [...parser.push(contentPart.text), ...parser.flush()];
                            for (const segment of segments) {
                                if (segment.type === "text") {
                                    if (segment.text.length > 0) {
                                        parts.push({ type: "text", text: segment.text });
                                    }
                                    continue;
                                }

                                const citation = await enrichCitation(params.id, segment.citation.id);
                                if (citation) {
                                    parts.push({ type: "citation", citation });
                                } else {
                                    parts.push({ type: "text", text: segment.raw });
                                }
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

                const finishMetadata = getFinishMetadata({
                    startedAt,
                    firstOutputAt: startedAt,
                    totalTokens: result.totalUsage.totalTokens,
                    inputTokens: result.totalUsage.inputTokens,
                    outputTokens: result.totalUsage.outputTokens,
                    modelId: env.AI_TEXT_MODEL,
                    usedFileCount: new Set(
                        parts
                            .filter(
                                (part): part is Extract<MessagePart, { type: "citation" }> => part.type === "citation"
                            )
                            .map((part) => part.citation.fileId)
                    ).size,
                });
                parts.push({ type: "metadata", metadata: finishMetadata });

                await updateAssistantMessage(assistantId, parts, "completed", finishMetadata);
                await touchChat(request.id);

                return {
                    id: request.id,
                    message: toAssistantReply(assistantId, parts, finishMetadata),
                };
            });

            if (replyResult.isErr()) {
                return mapChatError(status, replyResult.error);
            }

            return status(200, successResponse(replyResult.value));
        },
        {
            beforeHandle: requirePermissions({ graph: ["view"] }),
            params: t.Object({
                id: t.String(),
            }),
            body: requestBodySchema,
        }
    )
    .post(
        "/stream/:id",
        async ({ params, body, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const streamResult = await Result.tryPromise(async () => {
                const request = body as ChatRequest;
                await assertCanViewGraph(user, params.id);
                const { assistantId, client, tools, prompt } = await startReply(user.id, params.id, request);

                const startedAt = Date.now();
                let firstOutputAt: number | null = null;
                const assistantParts: MessagePart[] = [];
                const citationFileIds = new Set<string>();
                const reasoningBuffers = new Map<string, string>();
                // The AI SDK flips the `dynamic` flag between `tool-input-*`
                // and `tool-output-*` events when a tool input fails schema
                // validation: input events are emitted with `dynamic: false`
                // (the tool is statically resolved by name), but output events
                // come in as `dynamic: true` because the SDK falls back to its
                // generic dynamic-tool branch. On the client, the `dynamic`
                // flag decides whether a part is keyed as `tool-<name>` or
                // `dynamic-tool`, so the mid-lifecycle flip produces *two*
                // separate parts for a single `toolCallId` – a stale
                // `tool-<name>` part stuck in `input-available` AND a
                // `dynamic-tool` part with the error. We pin the flag to the
                // value seen on the first lifecycle event per call and reuse
                // it for all subsequent events so the UI SDK only ever builds
                // one part per tool call.
                const toolDynamicFlags = new Map<string, boolean>();

                const pinToolDynamic = (toolCallId: string, incoming: boolean | undefined): boolean => {
                    const existing = toolDynamicFlags.get(toolCallId);
                    if (existing !== undefined) return existing;
                    const value = Boolean(incoming);
                    toolDynamicFlags.set(toolCallId, value);
                    return value;
                };

                const result = streamText({
                    model: client.text!,
                    messages: uiMessagesToModelMessages(request.messages),
                    system: createChatSystemPrompt(prompt),
                    tools,
                    temperature: 0.3,
                    stopWhen: stepCountIs(50),
                    experimental_transform: smoothStream({
                        delayInMs: 20,
                        chunking: "word",
                    }),
                    providerOptions: getProviderOptions({ thinking: "medium" }),
                });

                const stream = createUIMessageStream<ChatUIMessage>({
                    execute: async ({ writer }) => {
                        writer.write({
                            type: "start",
                            messageId: assistantId,
                            messageMetadata: {
                                createdAt: new Date(startedAt).toISOString(),
                                modelId: env.AI_TEXT_MODEL,
                            },
                        });

                        const textParsers = new Map<string, ReturnType<typeof createCitationFenceStreamParser>>();

                        // Each model text block is split into one or more UI text blocks so
                        // that a `{type: "citation"}` part always lives BETWEEN the text
                        // parts that surround it. Without this split the AI SDK would
                        // accumulate every `text-delta` for a single text id into one big
                        // text part and push all citations as separate parts behind it –
                        // which is exactly the "references at end / references at start
                        // after reload" bug users were seeing.
                        type ActiveUIText = { uiId: string; buffer: string };
                        const activeUITexts = new Map<string, ActiveUIText>();
                        let uiTextBlockCounter = 0;

                        const openUIText = (modelPartId: string): ActiveUIText => {
                            const existing = activeUITexts.get(modelPartId);
                            if (existing) return existing;
                            const uiId = `${modelPartId}::${uiTextBlockCounter++}`;
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
                                await updateAssistantMessage(assistantId, assistantParts, "pending");
                            }
                            writer.write({ type: "text-end", id: active.uiId });
                            activeUITexts.delete(modelPartId);
                        };

                        const appendText = (modelPartId: string, text: string) => {
                            if (text.length === 0) return;
                            const active = openUIText(modelPartId);
                            active.buffer += text;
                            writer.write({ type: "text-delta", id: active.uiId, delta: text });
                        };

                        try {
                            for await (const part of result.fullStream) {
                                if (part.type !== "start" && part.type !== "start-step" && firstOutputAt === null) {
                                    firstOutputAt = Date.now();
                                }

                                switch (part.type) {
                                    case "text-start":
                                        // Parser is created eagerly, but the UI text block is
                                        // opened lazily on the first text segment so blocks
                                        // that start with a citation don't emit an empty one.
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

                                            const citation = await enrichCitation(params.id, segment.citation.id);
                                            if (!citation) {
                                                // Unknown citation – preserve the raw fence as
                                                // text so the model's original output isn't lost.
                                                appendText(part.id, segment.raw);
                                                continue;
                                            }

                                            // Close the current UI text block first so the
                                            // citation sits between this text chunk and the
                                            // next one in the persisted parts array.
                                            await closeUIText(part.id);
                                            citationFileIds.add(citation.fileId);
                                            assistantParts.push({ type: "citation", citation });
                                            await updateAssistantMessage(assistantId, assistantParts, "pending");
                                            writer.write({
                                                type: "data-citation",
                                                id: citation.sourceId,
                                                data: citation,
                                            });
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

                                                const citation = await enrichCitation(
                                                    params.id,
                                                    segment.citation.id
                                                );
                                                if (!citation) {
                                                    appendText(part.id, segment.raw);
                                                    continue;
                                                }

                                                await closeUIText(part.id);
                                                citationFileIds.add(citation.fileId);
                                                assistantParts.push({ type: "citation", citation });
                                                await updateAssistantMessage(assistantId, assistantParts, "pending");
                                                writer.write({
                                                    type: "data-citation",
                                                    id: citation.sourceId,
                                                    data: citation,
                                                });
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
                                        reasoningBuffers.set(
                                            part.id,
                                            `${reasoningBuffers.get(part.id) ?? ""}${part.text}`
                                        );
                                        writer.write({ type: "reasoning-delta", id: part.id, delta: part.text });
                                        break;
                                    case "reasoning-end": {
                                        const reasoning = reasoningBuffers.get(part.id) ?? "";
                                        if (reasoning.length > 0) {
                                            assistantParts.push({ type: "reasoning", text: reasoning });
                                            await updateAssistantMessage(assistantId, assistantParts, "pending");
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
                                    case "tool-input-delta": {
                                        writer.write({
                                            type: "tool-input-delta",
                                            toolCallId: part.id,
                                            inputTextDelta: part.delta,
                                        });
                                        break;
                                    }
                                    case "tool-call": {
                                        upsertToolPart(assistantParts, toolPart(part, "pending"));
                                        await updateAssistantMessage(assistantId, assistantParts, "pending");
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
                                    }
                                    case "tool-result": {
                                        upsertToolPart(assistantParts, toolPart(part, "completed", { value: part.output }));
                                        await updateAssistantMessage(assistantId, assistantParts, "pending");
                                        writer.write({
                                            type: "tool-output-available",
                                            toolCallId: part.toolCallId,
                                            output: part.output,
                                            providerExecuted: part.providerExecuted,
                                            dynamic: pinToolDynamic(part.toolCallId, part.dynamic),
                                            preliminary: part.preliminary,
                                        });
                                        break;
                                    }
                                    case "tool-error": {
                                        const errorText =
                                            typeof part.error === "string"
                                                ? part.error
                                                : JSON.stringify(part.error ?? null);
                                        upsertToolPart(assistantParts, toolPart(part, "failed", { value: errorText }));
                                        await updateAssistantMessage(assistantId, assistantParts, "pending");
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
                                        writer.write({ type: "tool-output-denied", toolCallId: part.toolCallId });
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
                                        assistantParts.push({ type: "metadata", metadata: finishMetadata });
                                        await updateAssistantMessage(
                                            assistantId,
                                            assistantParts,
                                            "completed",
                                            finishMetadata
                                        );
                                        await touchChat(request.id);
                                        writer.write({
                                            type: "finish",
                                            finishReason: part.finishReason,
                                            messageMetadata: finishMetadata,
                                        });
                                        break;
                                    }
                                    case "error": {
                                        const errorText =
                                            part.error instanceof Error ? part.error.message : String(part.error);
                                        await updateAssistantMessage(assistantId, assistantParts, "failed");
                                        writer.write({ type: "error", errorText });
                                        break;
                                    }
                                }
                            }
                        } catch (error) {
                            // Flush any still-open UI text block so partial content
                            // survives in the persisted message even when the stream
                            // aborts mid-way.
                            for (const modelPartId of [...activeUITexts.keys()]) {
                                await closeUIText(modelPartId);
                            }
                            const errorText = error instanceof Error ? error.message : "Unknown stream error";
                            await updateAssistantMessage(assistantId, assistantParts, "failed");
                            writer.write({ type: "error", errorText });
                            writer.write({ type: "finish", finishReason: "error" });
                        }
                    },
                });

                return createUIMessageStreamResponse({ stream });
            });

            if (streamResult.isErr()) {
                return mapChatError(status, streamResult.error);
            }

            return streamResult.value;
        },
        {
            beforeHandle: requirePermissions({ graph: ["view"] }),
            params: t.Object({
                id: t.String(),
            }),
            body: requestBodySchema,
        }
    );
