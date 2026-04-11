import {
    buildAdapter,
    buildChatTools,
    createChatSystemPrompt,
    createCitationFenceStreamParser,
    getClient,
    getProviderOptions,
    messagePartsToUIMessage,
    toUIMessage,
    type ChatMessageMetadata,
    type ChatUIMessage,
    type CitationPartData,
    uiMessageToMessageParts,
    uiMessagesToModelMessages,
} from "@kiwi/ai";
import { db } from "@kiwi/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { chatTable, messageTable, type MessagePart } from "@kiwi/db/tables/chats";
import { filesTable, sourcesTable, systemPromptsTable, textUnitTable } from "@kiwi/db/tables/graph";
import { Elysia, t } from "elysia";
import { createUIMessageStream, createUIMessageStreamResponse, generateText, smoothStream, stepCountIs, streamText } from "ai";
import { env } from "../env";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";
import { assertCanViewGraph } from "./graph";

type RouteStatus = (code: number, body: unknown) => unknown;
type ChatRequest = {
    id: string;
    messages: ChatUIMessage[];
};

type ChatSummary = {
    id: string;
    title: string;
    updatedAt: string | null;
};

type ChatHistory = {
    id: string;
    title: string;
    messages: ChatUIMessage[];
};

const requestBodySchema = t.Object({
    id: t.String(),
    messages: t.Array(t.Any()),
});

function normalizeWhitespace(value: string) {
    return value.replace(/\s+/g, " ").trim();
}

function createChatTitle(messages: ChatUIMessage[]) {
    const firstUserMessage = messages.find((message) => message.role === "user");
    const text = firstUserMessage
        ? firstUserMessage.parts
              .filter((part): part is Extract<ChatUIMessage["parts"][number], { type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join("")
        : "";
    const normalized = normalizeWhitespace(text);

    if (normalized.length === 0) {
        return "New chat";
    }

    return normalized.length > 80 ? `${normalized.slice(0, 77).trimEnd()}...` : normalized;
}

function parseCreatedAt(value?: string) {
    if (!value) {
        return undefined;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function getMetrics(metadata?: ChatMessageMetadata) {
    return {
        tokensPerSecond: metadata?.tokensPerSecond ?? null,
        timeToFirstToken: metadata?.timeToFirstToken ?? null,
        inputTokens: metadata?.inputTokens ?? null,
        outputTokens: metadata?.outputTokens ?? null,
        totalTokens: metadata?.totalTokens ?? null,
    };
}

function toolPart<T extends { toolCallId: string; toolName: string; providerExecuted?: boolean; input: unknown }>(
    part: T,
    status: "pending" | "completed" | "failed",
    result?: { value: unknown }
): Extract<MessagePart, { type: "tool" }> {
    return {
        type: "tool",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        execution: part.providerExecuted ? "server" : "client",
        status,
        args: part.input,
        ...(result ? { result: result.value } : {}),
    };
}

async function ensureChat(userId: string, graphId: string, request: ChatRequest) {
    const [existingChat] = await db
        .select({
            id: chatTable.id,
            userId: chatTable.userId,
            graphId: chatTable.graphId,
            title: chatTable.title,
        })
        .from(chatTable)
        .where(eq(chatTable.id, request.id))
        .limit(1);

    if (!existingChat) {
        await db.insert(chatTable).values({
            id: request.id,
            userId,
            graphId,
            title: createChatTitle(request.messages),
        });
        return;
    }

    if (existingChat.userId !== userId || existingChat.graphId !== graphId) {
        throw new Error(API_ERROR_CODES.CHAT_NOT_FOUND);
    }
}

async function touchChat(chatId: string) {
    await db.update(chatTable).set({ updatedAt: new Date() }).where(eq(chatTable.id, chatId));
}

async function syncMessages(chatId: string, messages: ChatUIMessage[]) {
    for (const message of messages) {
        const parts = uiMessageToMessageParts(message);
        const createdAt = parseCreatedAt(message.metadata?.createdAt);
        const metrics = getMetrics(message.metadata);
        const [existing] = await db
            .select({ id: messageTable.id })
            .from(messageTable)
            .where(and(eq(messageTable.chatId, chatId), eq(messageTable.id, message.id)))
            .limit(1);

        if (existing) {
            await db
                .update(messageTable)
                .set({
                    role: message.role,
                    status: "completed",
                    parts,
                    ...metrics,
                })
                .where(eq(messageTable.id, message.id));
            continue;
        }

        await db.insert(messageTable).values({
            id: message.id,
            chatId,
            role: message.role,
            status: "completed",
            parts,
            createdAt,
            ...metrics,
        });
    }
}

async function startReply(userId: string, graphId: string, request: ChatRequest) {
    await ensureChat(userId, graphId, request);
    await syncMessages(request.id, request.messages);

    const assistantId = crypto.randomUUID();
    await db.insert(messageTable).values({
        id: assistantId,
        chatId: request.id,
        role: "assistant",
        status: "pending",
        parts: [],
    });
    await touchChat(request.id);

    const [promptRow] = await db
        .select({ prompt: systemPromptsTable.prompt })
        .from(systemPromptsTable)
        .where(eq(systemPromptsTable.graphId, graphId))
        .orderBy(desc(systemPromptsTable.updatedAt), desc(systemPromptsTable.createdAt))
        .limit(1);

    return {
        assistantId,
        client: getClient({
            text: buildAdapter(
                env.AI_TEXT_ADAPTER,
                env.AI_TEXT_MODEL,
                env.AI_TEXT_KEY,
                env.AI_TEXT_URL,
                env.AI_TEXT_RESOURCE_NAME
            ),
        }),
        tools: buildChatTools(graphId),
        prompt: promptRow?.prompt ?? undefined,
    };
}

async function enrichCitation(graphId: string, sourceId: string): Promise<CitationPartData | null> {
    const [row] = await db
        .select({
            sourceId: sourcesTable.id,
            description: sourcesTable.description,
            textUnitId: textUnitTable.id,
            excerpt: textUnitTable.text,
            fileId: filesTable.id,
            fileName: filesTable.name,
            fileKey: filesTable.key,
        })
        .from(sourcesTable)
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
        .where(and(eq(sourcesTable.id, sourceId), eq(filesTable.graphId, graphId)))
        .limit(1);

    if (!row) {
        return null;
    }

    const excerpt = normalizeWhitespace(row.excerpt);

    return {
        id: row.sourceId,
        sourceId: row.sourceId,
        textUnitId: row.textUnitId,
        fileId: row.fileId,
        fileName: row.fileName,
        fileKey: row.fileKey,
        description: normalizeWhitespace(row.description),
        excerpt: excerpt.length > 260 ? `${excerpt.slice(0, 257).trimEnd()}...` : excerpt,
    };
}

async function loadChatHistory(userId: string, graphId: string, chatId: string): Promise<ChatHistory> {
    const [chat] = await db
        .select({
            id: chatTable.id,
            title: chatTable.title,
            userId: chatTable.userId,
            graphId: chatTable.graphId,
        })
        .from(chatTable)
        .where(eq(chatTable.id, chatId))
        .limit(1);

    if (!chat || chat.userId !== userId || chat.graphId !== graphId) {
        throw new Error(API_ERROR_CODES.CHAT_NOT_FOUND);
    }

    const rows = await db
        .select()
        .from(messageTable)
        .where(eq(messageTable.chatId, chatId))
        .orderBy(asc(messageTable.createdAt), asc(messageTable.id));

    return {
        id: chat.id,
        title: chat.title,
        messages: rows.map((message) => toUIMessage(message)),
    };
}

async function listChats(userId: string, graphId: string): Promise<ChatSummary[]> {
    const rows = await db
        .select({
            id: chatTable.id,
            title: chatTable.title,
            updatedAt: chatTable.updatedAt,
        })
        .from(chatTable)
        .where(and(eq(chatTable.userId, userId), eq(chatTable.graphId, graphId)))
        .orderBy(desc(chatTable.updatedAt), desc(chatTable.createdAt));

    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updatedAt?.toISOString() ?? null,
    }));
}

function getFinishMetadata(options: {
    startedAt: number;
    firstOutputAt: number | null;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    modelId: string;
    usedFileCount?: number;
}): ChatMessageMetadata {
    const durationMs = Math.max(1, Date.now() - options.startedAt);
    const outputTokens = options.outputTokens;

    return {
        modelId: options.modelId,
        totalTokens: options.totalTokens,
        inputTokens: options.inputTokens,
        outputTokens,
        durationMs,
        timeToFirstToken: options.firstOutputAt ? options.firstOutputAt - options.startedAt : undefined,
        tokensPerSecond: outputTokens && durationMs > 0 ? outputTokens / Math.max(durationMs / 1000, 0.001) : undefined,
        usedFileCount: options.usedFileCount,
    };
}

async function updateAssistantMessage(
    assistantMessageId: string,
    parts: MessagePart[],
    status: "pending" | "completed" | "failed",
    metadata?: ChatMessageMetadata
) {
    const metrics = getMetrics(metadata);

    await db
        .update(messageTable)
        .set({
            parts,
            status,
            ...metrics,
        })
        .where(eq(messageTable.id, assistantMessageId));
}

function mapChatError(status: RouteStatus, error: unknown) {
    if (!(error instanceof Error)) {
        return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }

    if (error.message === API_ERROR_CODES.GRAPH_NOT_FOUND) {
        return status(404, errorResponse("Graph not found", API_ERROR_CODES.GRAPH_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.GROUP_NOT_FOUND) {
        return status(404, errorResponse("Group not found", API_ERROR_CODES.GROUP_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.INVALID_GRAPH_OWNER) {
        return status(400, errorResponse("Invalid graph owner chain", API_ERROR_CODES.INVALID_GRAPH_OWNER));
    }

    if (error.message === API_ERROR_CODES.FORBIDDEN) {
        return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
    }

    if (error.message === API_ERROR_CODES.CHAT_NOT_FOUND) {
        return status(404, errorResponse("Chat not found", API_ERROR_CODES.CHAT_NOT_FOUND));
    }

    return status(500, errorResponse(error.message || "Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
}

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
                        message: messagePartsToUIMessage(
                            {
                                id: assistantId,
                                role: "assistant",
                                parts,
                                createdAt: new Date(),
                            },
                            finishMetadata
                        ),
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
                                            writer.write({ type: "data-citation", id: citation.id, data: citation });
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
                                                            id: citation.id,
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
