import {
    buildAdapter,
    buildDeepResearchToolset,
    buildEmbeddingAdapter,
    buildMcpResearchToolset,
    buildServerAndClientToolset,
    buildServerToolset,
    buildSubagentToolset,
    getClient,
    isPDFCitation,
    isResolvedCitationFence,
    messagePartsToUIMessage,
    toUIMessage,
    type ChatMessageMetadata,
    type ChatUIMessage,
    type CitationFence,
    type GraphToolsetOptions,
    type ResolvedCitationFence,
    uiMessageToMessageParts,
} from "@kiwi/ai";
import { db } from "@kiwi/db";
import { chatTable, messageTable, type MessagePart } from "@kiwi/db/tables/chats";
import { filesTable, sourcesTable, systemPromptsTable, textUnitTable } from "@kiwi/db/tables/graph";
import { error as logError } from "@kiwi/logger";
import { and, asc, desc, eq } from "drizzle-orm";
import { env } from "../env";
import { createProjectFileAccessToken } from "./project-file-access-token";
import { getProjectFileProxyUrl } from "./project-file-url";
import { normalizeMessageCitationFences, type CitationResolver } from "./chat-citation-normalization";
import { API_ERROR_CODES, errorResponse } from "../types";
import type { ChatRequestBody } from "../types/routes";

type RouteStatus = (code: number, body: unknown) => unknown;

export type ChatRequest = ChatRequestBody;

type StartReplyOptions = {
    toolset: "server" | "server-and-client" | "mcp";
    deep?: boolean;
};

export const DEFAULT_CHAT_TITLE = "...";

function buildBaseToolset(options: GraphToolsetOptions, toolset: StartReplyOptions["toolset"]) {
    switch (toolset) {
        case "server-and-client":
            return buildServerAndClientToolset(options);
        case "mcp":
            return buildMcpResearchToolset(options);
        case "server":
            return buildServerToolset(options);
    }
}

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

export function createChatTitle(messages: ChatUIMessage[]) {
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
            title: DEFAULT_CHAT_TITLE,
        });
        return { isNewChat: true };
    }

    if (existingChat.userId !== userId || existingChat.graphId !== graphId) {
        throw new Error(API_ERROR_CODES.CHAT_NOT_FOUND);
    }

    return { isNewChat: false };
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

export async function getGraphResearchRuntime(graphId: string, options: StartReplyOptions = { toolset: "server" }) {
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
        subagent: buildAdapter(
            env.AI_TEXT_ADAPTER,
            env.AI_SUBAGENT_MODEL ?? env.AI_TEXT_MODEL,
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
        throw new Error("Text and embedding models are required");
    }

    const toolsetOptions = { graphId, embeddingModel: client.embedding };
    const baseToolset = buildBaseToolset(toolsetOptions, options.toolset);
    const tools = options.deep
        ? buildDeepResearchToolset(
              buildSubagentToolset({
                  ...toolsetOptions,
                  model: client.subagent ?? client.text,
                  graphPrompt: promptRow?.prompt ?? undefined,
              })
          )
        : baseToolset;

    return {
        client,
        tools,
        prompt: promptRow?.prompt ?? undefined,
    };
}

export async function startReply(userId: string, graphId: string, request: ChatRequest, options: StartReplyOptions) {
    const { isNewChat } = await ensureChat(userId, graphId, request);
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

    const runtime = await getGraphResearchRuntime(graphId, options);

    return {
        assistantId,
        isNewChat,
        ...runtime,
    };
}

export async function enrichCitation(graphId: string, sourceId: string): Promise<ResolvedCitationFence | null> {
    const [row] = await db
        .select({
            sourceId: sourcesTable.id,
            unitId: textUnitTable.id,
            fileId: filesTable.id,
            fileName: filesTable.name,
            fileType: filesTable.type,
            startPage: textUnitTable.startPage,
            endPage: textUnitTable.endPage,
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
        fileId: row.fileId,
        fileName: row.fileName,
        fileType: row.fileType,
        startPage: row.startPage ?? undefined,
        endPage: row.endPage ?? undefined,
    };
}

function createCachedCitationResolver(graphId: string): CitationResolver {
    const citationCache = new Map<string, Promise<ResolvedCitationFence | null>>();

    return (citation) => {
        let resolvedCitation = citationCache.get(citation.sourceId);
        if (!resolvedCitation) {
            resolvedCitation = enrichCitation(graphId, citation.sourceId);
            citationCache.set(citation.sourceId, resolvedCitation);
        }

        return resolvedCitation;
    };
}

export async function resolveCitationDocumentLink(
    graphId: string,
    citation: CitationFence,
    options: { baseUrl?: string; signed?: boolean } = {}
) {
    try {
        const resolvedCitation =
            isResolvedCitationFence(citation) && citation.fileId
                ? citation
                : await enrichCitation(graphId, citation.sourceId);

        if (!resolvedCitation?.fileId) {
            return "[source unavailable]";
        }

        const page = isPDFCitation(resolvedCitation) ? resolvedCitation.startPage : null;
        const token = options.signed ? await createProjectFileAccessToken(graphId, resolvedCitation.fileId) : undefined;
        const url = getProjectFileProxyUrl(options.baseUrl, graphId, resolvedCitation.fileId, {
            fileName: resolvedCitation.fileName,
            page,
            token,
        });
        const label = resolvedCitation.fileName.replaceAll("[", "\\[").replaceAll("]", "\\]");

        return `[${label}](${url})`;
    } catch (error) {
        logError("failed to resolve citation document link", {
            graphId,
            sourceId: citation.sourceId,
            error,
        });

        return "[source unavailable]";
    }
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

    const resolveCitation = createCachedCitationResolver(graphId);
    const messages = await Promise.all(
        rows.map(async (message) => {
            const normalized = await normalizeMessageCitationFences(message.parts, resolveCitation);
            if (normalized.changed) {
                await db
                    .update(messageTable)
                    .set({ parts: normalized.parts })
                    .where(and(eq(messageTable.id, message.id), eq(messageTable.chatId, chatId)));
            }

            return toUIMessage({
                ...message,
                parts: normalized.parts,
            });
        })
    );

    return {
        id: chat.id,
        title: chat.title,
        messages,
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

    const message = error.message;
    const causeMessage = error.cause instanceof Error ? error.cause.message : undefined;
    const hasErrorCode = (code: string) => message === code || causeMessage === code || message.includes(code);

    if (hasErrorCode(API_ERROR_CODES.GRAPH_NOT_FOUND)) {
        return status(404, errorResponse("Graph not found", API_ERROR_CODES.GRAPH_NOT_FOUND));
    }

    if (hasErrorCode(API_ERROR_CODES.INVALID_GRAPH_OWNER)) {
        return status(400, errorResponse("Invalid graph owner chain", API_ERROR_CODES.INVALID_GRAPH_OWNER));
    }

    if (hasErrorCode(API_ERROR_CODES.FORBIDDEN)) {
        return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
    }

    if (hasErrorCode(API_ERROR_CODES.CHAT_NOT_FOUND)) {
        return status(404, errorResponse("Chat not found", API_ERROR_CODES.CHAT_NOT_FOUND));
    }

    return status(500, errorResponse(error.message || "Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
}
