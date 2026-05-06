import {
    buildAdapter,
    buildEmbeddingAdapter,
    buildChatTools,
    type CitationFence,
    getClient,
    isResolvedCitationFence,
    messagePartsToUIMessage,
    toUIMessage,
    type ChatMessageMetadata,
    type ChatUIMessage,
    type ResolvedCitationFence,
    uiMessageToMessageParts,
} from "@kiwi/ai";
import { db } from "@kiwi/db";
import { chatTable, messageTable, type MessagePart } from "@kiwi/db/tables/chats";
import { filesTable, sourcesTable, systemPromptsTable, textUnitTable } from "@kiwi/db/tables/graph";
import { getPresignedDownloadUrl } from "@kiwi/files";
import { and, asc, desc, eq } from "drizzle-orm";
import { env } from "../env";
import { API_ERROR_CODES, errorResponse } from "../types";
import type { ChatRequestBody } from "../types/routes";

type RouteStatus = (code: number, body: unknown) => unknown;

export type ChatRequest = ChatRequestBody;

export function toAssistantReply(assistantId: string, parts: MessagePart[], metadata: ChatMessageMetadata) {
    return messagePartsToUIMessage(
        {
            id: assistantId,
            role: "assistant",
            parts,
            createdAt: new Date(),
        },
        metadata
    );
}

function createChatTitle(messages: ChatUIMessage[]) {
    const firstUserMessage = messages.find((message) => message.role === "user");
    const text = firstUserMessage
        ? firstUserMessage.parts
              .filter((part): part is Extract<ChatUIMessage["parts"][number], { type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join("")
        : "";
    const title = text.replace(/\s+/g, " ").trim();

    if (title.length === 0) {
        return "New chat";
    }

    return title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title;
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

export function toolPart<
    T extends { toolCallId: string; toolName: string; providerExecuted?: boolean; input: unknown },
>(
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

export async function touchChat(chatId: string) {
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

export async function getGraphResearchRuntime(graphId: string) {
    const [promptRow] = await db
        .select({ prompt: systemPromptsTable.prompt })
        .from(systemPromptsTable)
        .where(eq(systemPromptsTable.graphId, graphId))
        .orderBy(desc(systemPromptsTable.updatedAt), desc(systemPromptsTable.createdAt))
        .limit(1);

    const client = getClient({
        text: buildAdapter(
            env.AI_TEXT_ADAPTER,
            env.AI_TEXT_MODEL,
            env.AI_TEXT_KEY,
            env.AI_TEXT_URL,
            env.AI_TEXT_RESOURCE_NAME
        ),
        embedding: buildEmbeddingAdapter(
            env.AI_EMBEDDING_ADAPTER,
            env.AI_EMBEDDING_MODEL,
            env.AI_EMBEDDING_KEY,
            env.AI_EMBEDDING_URL,
            env.AI_EMBEDDING_RESOURCE_NAME
        ),
    });

    if (!client.text || !client.embedding) {
        throw new Error("Text and embedding models are required for chat");
    }

    return {
        client,
        tools: buildChatTools(graphId, client.embedding),
        prompt: promptRow?.prompt ?? undefined,
    };
}

export async function startReply(userId: string, graphId: string, request: ChatRequest) {
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

    const runtime = await getGraphResearchRuntime(graphId);

    return {
        assistantId,
        ...runtime,
    };
}

export async function enrichCitation(graphId: string, sourceId: string): Promise<ResolvedCitationFence | null> {
    const [row] = await db
        .select({
            sourceId: sourcesTable.id,
            unitId: textUnitTable.id,
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

    return {
        type: "cite",
        sourceId: row.sourceId,
        unitId: row.unitId,
        fileName: row.fileName,
        fileKey: row.fileKey,
    };
}

export async function resolveCitationDocumentLink(graphId: string, citation: CitationFence) {
    const resolvedCitation = isResolvedCitationFence(citation)
        ? citation
        : await enrichCitation(graphId, citation.sourceId);

    if (!resolvedCitation) {
        return "[source unavailable]";
    }

    const url = getPresignedDownloadUrl(resolvedCitation.fileKey, env.S3_BUCKET);
    const label = resolvedCitation.fileName.replaceAll("[", "\\[").replaceAll("]", "\\]");

    return `[${label}](${url})`;
}

export async function loadChatHistory(userId: string, graphId: string, chatId: string) {
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

export async function listChats(userId: string, graphId: string) {
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

export function getFinishMetadata(options: {
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

export async function updateAssistantMessage(
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

export function mapChatError(status: RouteStatus, error: unknown) {
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
