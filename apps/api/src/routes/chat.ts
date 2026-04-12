import {
    createChatSystemPrompt,
    createCitationFenceStreamParser,
    getProviderOptions,
    type ChatUIMessage,
    uiMessagesToModelMessages,
} from "@kiwi/ai";
import { db } from "@kiwi/db";
import { eq } from "drizzle-orm";
import { chatTable, type MessagePart } from "@kiwi/db/tables/chats";
import { Elysia, t } from "elysia";
import { createUIMessageStream, createUIMessageStreamResponse, generateText, smoothStream, stepCountIs, streamText } from "ai";
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

export const chatRoute = new Elysia()
    .use(authMiddleware)
    .get(
        "/chat/:id",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            try {
                await assertCanViewGraph(user, params.id);
                return status(200, successResponse(await listChats(user.id, params.id)));
            } catch (error) {
                return mapChatError(status, error);
            }
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

            try {
                await assertCanViewGraph(user, params.id);
                return status(200, successResponse(await loadChatHistory(user.id, params.id, params.chatId)));
            } catch (error) {
                return mapChatError(status, error);
            }
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

            try {
                await assertCanViewGraph(user, params.id);
                const history = await loadChatHistory(user.id, params.id, params.chatId);
                await db.delete(chatTable).where(eq(chatTable.id, history.id));
                return status(204, null);
            } catch (error) {
                return mapChatError(status, error);
            }
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

            try {
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
                            parts.push(toolPart(contentPart, "pending"));
                            break;
                        case "tool-result":
                            parts.push(toolPart(contentPart, "completed", { value: contentPart.output }));
                            break;
                        case "tool-error":
                            parts.push(
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

                return status(
                    200,
                    successResponse({
                        id: request.id,
                        message: toAssistantReply(assistantId, parts, finishMetadata),
                    })
                );
            } catch (error) {
                return mapChatError(status, error);
            }
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

            try {
                const request = body as ChatRequest;
                await assertCanViewGraph(user, params.id);
                const { assistantId, client, tools, prompt } = await startReply(user.id, params.id, request);

                const startedAt = Date.now();
                let firstOutputAt: number | null = null;
                const assistantParts: MessagePart[] = [];
                const citationFileIds = new Set<string>();
                const textBuffers = new Map<string, string>();
                const reasoningBuffers = new Map<string, string>();

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
                    originalMessages: request.messages,
                    execute: async ({ writer }) => {
                        writer.write({
                            type: "start",
                            messageId: assistantId,
                            messageMetadata: {
                                createdAt: new Date(startedAt).toISOString(),
                                modelId: env.AI_TEXT_MODEL,
                            },
                        });

                        try {
                            const textParsers = new Map<string, ReturnType<typeof createCitationFenceStreamParser>>();

                            for await (const part of result.fullStream) {
                                if (part.type !== "start" && part.type !== "start-step" && firstOutputAt === null) {
                                    firstOutputAt = Date.now();
                                }

                                switch (part.type) {
                                    case "text-start":
                                        textParsers.set(part.id, createCitationFenceStreamParser());
                                        textBuffers.set(part.id, "");
                                        writer.write({ type: "text-start", id: part.id });
                                        break;
                                    case "text-delta": {
                                        const parser = textParsers.get(part.id);
                                        if (!parser) {
                                            break;
                                        }

                                        for (const segment of parser.push(part.text)) {
                                            if (segment.type === "text") {
                                                if (segment.text.length > 0) {
                                                    textBuffers.set(
                                                        part.id,
                                                        `${textBuffers.get(part.id) ?? ""}${segment.text}`
                                                    );
                                                    writer.write({
                                                        type: "text-delta",
                                                        id: part.id,
                                                        delta: segment.text,
                                                    });
                                                }
                                                continue;
                                            }

                                            const citation = await enrichCitation(params.id, segment.citation.id);
                                            if (!citation) {
                                                textBuffers.set(
                                                    part.id,
                                                    `${textBuffers.get(part.id) ?? ""}${segment.raw}`
                                                );
                                                writer.write({ type: "text-delta", id: part.id, delta: segment.raw });
                                                continue;
                                            }

                                            citationFileIds.add(citation.fileId);
                                            assistantParts.push({ type: "citation", citation });
                                            await updateAssistantMessage(assistantId, assistantParts, "pending");
                                            writer.write({ type: "data-citation", id: citation.sourceId, data: citation });
                                        }
                                        break;
                                    }
                                    case "text-end": {
                                        const parser = textParsers.get(part.id);
                                        if (parser) {
                                            for (const segment of parser.flush()) {
                                                if (segment.type === "text") {
                                                    textBuffers.set(
                                                        part.id,
                                                        `${textBuffers.get(part.id) ?? ""}${segment.text}`
                                                    );
                                                    writer.write({
                                                        type: "text-delta",
                                                        id: part.id,
                                                        delta: segment.text,
                                                    });
                                                } else {
                                                    const citation = await enrichCitation(
                                                        params.id,
                                                        segment.citation.id
                                                    );
                                                    if (citation) {
                                                        citationFileIds.add(citation.fileId);
                                                        assistantParts.push({ type: "citation", citation });
                                                        await updateAssistantMessage(assistantId, assistantParts, "pending");
                                                        writer.write({
                                                            type: "data-citation",
                                                            id: citation.sourceId,
                                                            data: citation,
                                                        });
                                                    } else {
                                                        textBuffers.set(
                                                            part.id,
                                                            `${textBuffers.get(part.id) ?? ""}${segment.raw}`
                                                        );
                                                        writer.write({
                                                            type: "text-delta",
                                                            id: part.id,
                                                            delta: segment.raw,
                                                        });
                                                    }
                                                }
                                            }
                                        }

                                        const text = textBuffers.get(part.id) ?? "";
                                        if (text.length > 0) {
                                            assistantParts.push({ type: "text", text });
                                            await updateAssistantMessage(assistantId, assistantParts, "pending");
                                        }
                                        writer.write({ type: "text-end", id: part.id });
                                        textBuffers.delete(part.id);
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
                                            dynamic: part.dynamic,
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
                                        assistantParts.push(toolPart(part, "pending"));
                                        await updateAssistantMessage(assistantId, assistantParts, "pending");
                                        writer.write({
                                            type: "tool-input-available",
                                            toolCallId: part.toolCallId,
                                            toolName: part.toolName,
                                            input: part.input,
                                            providerExecuted: part.providerExecuted,
                                            dynamic: part.dynamic,
                                            title: part.title,
                                        });
                                        break;
                                    }
                                    case "tool-result": {
                                        assistantParts.push(toolPart(part, "completed", { value: part.output }));
                                        await updateAssistantMessage(assistantId, assistantParts, "pending");
                                        writer.write({
                                            type: "tool-output-available",
                                            toolCallId: part.toolCallId,
                                            output: part.output,
                                            providerExecuted: part.providerExecuted,
                                            dynamic: part.dynamic,
                                            preliminary: part.preliminary,
                                        });
                                        break;
                                    }
                                    case "tool-error": {
                                        const errorText =
                                            typeof part.error === "string"
                                                ? part.error
                                                : JSON.stringify(part.error ?? null);
                                        assistantParts.push(toolPart(part, "failed", { value: errorText }));
                                        await updateAssistantMessage(assistantId, assistantParts, "pending");
                                        writer.write({
                                            type: "tool-output-error",
                                            toolCallId: part.toolCallId,
                                            errorText,
                                            providerExecuted: part.providerExecuted,
                                            dynamic: part.dynamic,
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
                            const errorText = error instanceof Error ? error.message : "Unknown stream error";
                            await updateAssistantMessage(assistantId, assistantParts, "failed");
                            writer.write({ type: "error", errorText });
                            writer.write({ type: "finish", finishReason: "error" });
                        }
                    },
                });

                return createUIMessageStreamResponse({ stream });
            } catch (error) {
                return mapChatError(status, error);
            }
        },
        {
            beforeHandle: requirePermissions({ graph: ["view"] }),
            params: t.Object({
                id: t.String(),
            }),
            body: requestBodySchema,
        }
    );
