import {
    buildChatValidationToolset,
    compactConversationHistory,
    createChatSystemPrompt,
    estimateToken,
    prepareCitationFencesForModel,
    chatDataPartSchemas,
    chatMessageMetadataSchema,
    toModelMessage,
    toUIMessage,
    uiMessagesToModelMessages,
    type ChatMessageMetadata,
    type ChatUIMessage,
    type Client,
} from "@kiwi/ai";
import { db } from "@kiwi/db";
import {
    chatTable,
    messageTable,
    type ChatMessage,
    type MessageCompactionPart,
    type MessagePart,
} from "@kiwi/db/tables/chats";
import { validateUIMessages, type ModelMessage } from "ai";
import { and, asc, eq, ne } from "drizzle-orm";
import { env } from "../env";
import { API_ERROR_CODES } from "../types";
import type { ChatRequestBody } from "../types/routes";

const MAX_RAW_TAIL_TARGET_TOKENS = 32_000;
const MIN_RAW_VISIBLE_MESSAGES = 6;
const SOFT_COMPACTION_THRESHOLD_RATIO = 0.7;
const RAW_TAIL_TARGET_CONTEXT_RATIO = 1 - SOFT_COMPACTION_THRESHOLD_RATIO;
const MAX_COMPACTION_ATTEMPTS = 5;

export type ChatRequest = ChatRequestBody;

export type PromptOptions = {
    includeGraphTools?: boolean;
    includeClientTools?: boolean;
    includeSubagentTools?: boolean;
};

export type NormalizedChatRequest = {
    id: string;
    deep?: boolean;
    latestMessage: ChatUIMessage;
    titleMessages: ChatUIMessage[];
};

type ActiveCompaction = {
    messageId: string;
    part: MessageCompactionPart;
};

export type ChatRuntime = {
    client: Client & {
        text: NonNullable<Client["text"]>;
        embedding: NonNullable<Client["embedding"]>;
    };
    tools: Record<string, unknown>;
    prompt?: string;
};

export type ActiveChatContext = {
    activeCompaction?: ActiveCompaction;
    activeRawTailRows: ChatMessage[];
    validatedMessages: ChatUIMessage[];
    contextMessages: ModelMessage[];
    activeSummary?: string;
    estimatedPromptTokens: number;
};

function isCompactionPart(part: MessagePart): part is MessageCompactionPart {
    return part.type === "compaction";
}

function getCompactionPart(parts: MessagePart[]) {
    return parts.find(isCompactionPart);
}

export function isCompactionMessage(message: Pick<ChatMessage, "role" | "parts">) {
    return message.role === "system" && message.parts.some(isCompactionPart);
}

function createCompactionSystemMessage(summary: string): ModelMessage {
    return {
        role: "system",
        content: ["Conversation summary checkpoint:", summary].join("\n\n"),
    };
}

function estimateContextTokens(
    systemPrompt: string,
    contextMessages: ModelMessage[],
    tools?: Record<string, unknown>
) {
    return estimateToken(
        JSON.stringify({
            system: systemPrompt,
            messages: contextMessages,
            ...(tools ? { tools } : {}),
        })
    );
}

export function replaceOrAppendMessage<T extends { id: string }>(messages: T[], next: T) {
    const existingIndex = messages.findIndex((message) => message.id === next.id);
    if (existingIndex === -1) {
        return [...messages, next];
    }

    return messages.map((message, index) => (index === existingIndex ? next : message));
}

export function normalizeChatRequest(request: ChatRequest): NormalizedChatRequest {
    if ("message" in request && request.message) {
        return {
            id: request.id,
            deep: request.deep,
            latestMessage: request.message,
            titleMessages: [request.message],
        };
    }

    if ("messages" in request && request.messages.length > 0) {
        return {
            id: request.id,
            deep: request.deep,
            latestMessage: request.messages[request.messages.length - 1]!,
            titleMessages: request.messages,
        };
    }

    throw new Error(API_ERROR_CODES.INVALID_CHAT_REQUEST);
}

export async function loadChatRows(chatId: string, options?: { includeFailed?: boolean }) {
    return db
        .select()
        .from(messageTable)
        .where(
            options?.includeFailed
                ? and(eq(messageTable.chatId, chatId), ne(messageTable.status, "pending"))
                : and(
                      eq(messageTable.chatId, chatId),
                      ne(messageTable.status, "pending"),
                      ne(messageTable.status, "failed")
                  )
        )
        .orderBy(asc(messageTable.createdAt), asc(messageTable.id));
}

export function deriveActiveCompaction(rows: ChatMessage[]) {
    const rawVisibleRows = rows.filter((message) => !isCompactionMessage(message));
    const latestCompactionMessage = [...rows].reverse().find((message) => isCompactionMessage(message));
    const activeCompactionPart = latestCompactionMessage ? getCompactionPart(latestCompactionMessage.parts) : undefined;

    if (!latestCompactionMessage || !activeCompactionPart) {
        return {
            rawVisibleRows,
            activeRawTailRows: rawVisibleRows,
            activeCompaction: undefined,
        };
    }

    const boundaryIndex = rawVisibleRows.findIndex(
        (message) => message.id === activeCompactionPart.summarizedThroughMessageId
    );

    return {
        rawVisibleRows,
        activeRawTailRows: boundaryIndex === -1 ? rawVisibleRows : rawVisibleRows.slice(boundaryIndex + 1),
        activeCompaction: {
            messageId: latestCompactionMessage.id,
            part: activeCompactionPart,
        } satisfies ActiveCompaction,
    };
}

async function validateTailMessages(options: {
    graphId: string;
    rawTailRows: ChatMessage[];
    runtime: ChatRuntime;
}) {
    const messages: ChatUIMessage[] = options.rawTailRows.map((message) => toUIMessage(message));
    const validationToolset = buildChatValidationToolset({
        graphId: options.graphId,
        embeddingModel: options.runtime.client.embedding,
        model: options.runtime.client.subagent ?? options.runtime.client.text,
        graphPrompt: options.runtime.prompt,
    });

    return await validateUIMessages<ChatUIMessage>({
        messages,
        tools: validationToolset,
        metadataSchema: chatMessageMetadataSchema,
        dataSchemas: chatDataPartSchemas,
    });
}

export async function buildActiveChatContext(options: {
    graphId: string;
    rows: ChatMessage[];
    runtime: ChatRuntime;
    systemPrompt: string;
}) {
    const compactionState = deriveActiveCompaction(options.rows);
    const validatedMessages = await validateTailMessages({
        graphId: options.graphId,
        rawTailRows: compactionState.activeRawTailRows,
        runtime: options.runtime,
    });
    const activeSummary = compactionState.activeCompaction?.part.summary;
    const contextMessages = [
        ...(activeSummary ? [createCompactionSystemMessage(activeSummary)] : []),
        ...uiMessagesToModelMessages(validatedMessages),
    ];

    return {
        activeCompaction: compactionState.activeCompaction,
        activeRawTailRows: compactionState.activeRawTailRows,
        validatedMessages,
        contextMessages,
        activeSummary,
        estimatedPromptTokens: estimateContextTokens(options.systemPrompt, contextMessages, options.runtime.tools),
    } satisfies ActiveChatContext;
}

function estimateStoredMessageTokens(message: ChatMessage) {
    return estimateToken(JSON.stringify(toModelMessage(message)));
}

export function getSoftCompactionThreshold(contextWindow = env.CONTEXT_WINDOW) {
    return Math.max(1, Math.floor(contextWindow * SOFT_COMPACTION_THRESHOLD_RATIO));
}

export function getRawTailTargetTokens(contextWindow = env.CONTEXT_WINDOW) {
    return Math.max(
        1,
        Math.floor(Math.min(MAX_RAW_TAIL_TARGET_TOKENS, contextWindow * RAW_TAIL_TARGET_CONTEXT_RATIO))
    );
}

function shouldCompact(estimatedPromptTokens: number) {
    return estimatedPromptTokens >= getSoftCompactionThreshold();
}

export function assertCompactionAttemptsRemaining(attemptCount: number) {
    if (attemptCount >= MAX_COMPACTION_ATTEMPTS) {
        throw new Error(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
    }
}

export function getProtectedTailStartIndex(rows: ChatMessage[]) {
    if (rows.length === 0) {
        return 0;
    }

    const messageTokenCounts = rows.map((message) => estimateStoredMessageTokens(message));
    let startIndex = rows.length;
    let protectedTokens = 0;
    const minimumProtectedTailStartIndex = Math.max(0, rows.length - MIN_RAW_VISIBLE_MESSAGES);
    const rawTailTargetTokens = getRawTailTargetTokens();

    for (let index = rows.length - 1; index >= 0; index -= 1) {
        startIndex = index;
        protectedTokens += messageTokenCounts[index]!;

        const protectedCount = rows.length - index;
        if (protectedCount >= MIN_RAW_VISIBLE_MESSAGES && protectedTokens >= rawTailTargetTokens) {
            break;
        }
    }

    if (protectedTokens < rawTailTargetTokens) {
        startIndex = minimumProtectedTailStartIndex;
    }

    return startIndex;
}

export function serializeCompactionTranscript(messages: ChatUIMessage[]) {
    return messages
        .map((message, index) => {
            const lines = [`## Message ${index + 1}`, `Role: ${message.role}`];

            for (const part of message.parts) {
                if (part.type === "text") {
                    const text = part.text.trim();
                    if (text) {
                        lines.push("Text:", text);
                    }
                    continue;
                }

                if (part.type === "reasoning" || !("toolCallId" in part)) {
                    continue;
                }

                const toolPart = part as {
                    type: string;
                    toolCallId: string;
                    toolName?: string;
                    state?: string;
                    input?: unknown;
                    output?: unknown;
                    errorText?: string;
                    args?: unknown;
                    result?: unknown;
                    status?: "pending" | "completed" | "failed";
                };

                const inputValue = toolPart.input ?? toolPart.args;
                const outputValue =
                    toolPart.output !== undefined
                        ? toolPart.output
                        : toolPart.status === "completed"
                          ? toolPart.result
                          : undefined;
                const errorText =
                    toolPart.errorText ??
                    (toolPart.status === "failed"
                        ? typeof toolPart.result === "string"
                            ? toolPart.result
                            : JSON.stringify(toolPart.result)
                        : undefined);
                const state =
                    toolPart.state ??
                    toolPart.status ??
                    (outputValue !== undefined ? "output-available" : "input-available");

                lines.push(`Tool: ${toolPart.toolName ?? toolPart.type}`);
                lines.push(`State: ${state}`);
                if (inputValue !== undefined) {
                    lines.push(`Input: ${JSON.stringify(inputValue)}`);
                }
                if (outputValue !== undefined) {
                    lines.push(`Output: ${JSON.stringify(outputValue)}`);
                }
                if (errorText) {
                    lines.push(`Error: ${errorText}`);
                }
            }

            return lines.join("\n");
        })
        .join("\n\n");
}

export function normalizeCompactionSummary(summary: string) {
    const trimmedSummary = summary.trim();
    if (trimmedSummary.length === 0) {
        throw new Error("Compaction summary was empty");
    }

    return prepareCitationFencesForModel(trimmedSummary);
}

async function insertCheckpoint(options: {
    chatId: string;
    graphPrompt?: string;
    runtime: ChatRuntime;
    previousSummary?: string;
    basedOnCompactionMessageId?: string;
    summarizedMessages: ChatUIMessage[];
    summarizedThroughMessageId: string;
    abortSignal?: AbortSignal;
}) {
    const transcript = serializeCompactionTranscript(options.summarizedMessages);
    const summary = await compactConversationHistory({
        model: options.runtime.client.subagent ?? options.runtime.client.text,
        graphPrompt: options.graphPrompt,
        previousSummary: options.previousSummary,
        transcript,
        abortSignal: options.abortSignal,
    });
    options.abortSignal?.throwIfAborted();
    const compactionPart: MessageCompactionPart = {
        type: "compaction",
        version: 1,
        summary: normalizeCompactionSummary(summary),
        summarizedThroughMessageId: options.summarizedThroughMessageId,
        basedOnCompactionMessageId: options.basedOnCompactionMessageId,
    };

    await db.insert(messageTable).values({
        chatId: options.chatId,
        role: "system",
        status: "completed",
        parts: [compactionPart],
    });
}

export async function maybeCompactConversation(options: {
    chatId: string;
    graphId: string;
    runtime: ChatRuntime;
    rows: ChatMessage[];
    promptOptions?: PromptOptions;
    forceCompaction?: boolean;
    abortSignal?: AbortSignal;
}) {
    const systemPrompt = createChatSystemPrompt(options.runtime.prompt, options.promptOptions ?? {});
    let context = await buildActiveChatContext({
        graphId: options.graphId,
        rows: options.rows,
        runtime: options.runtime,
        systemPrompt,
    });
    let forceCompaction = options.forceCompaction === true;
    let compactionAttempts = 0;

    if (!forceCompaction && !shouldCompact(context.estimatedPromptTokens)) {
        return { context, systemPrompt };
    }

    while (forceCompaction || shouldCompact(context.estimatedPromptTokens)) {
        const isForcedCompaction = forceCompaction;
        assertCompactionAttemptsRemaining(compactionAttempts);
        compactionAttempts += 1;
        forceCompaction = false;
        const protectedTailStartIndex = getProtectedTailStartIndex(context.activeRawTailRows);
        if (protectedTailStartIndex <= 0) {
            if (!isForcedCompaction) {
                break;
            }
            throw new Error(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
        }

        const summarizedRows = context.activeRawTailRows.slice(0, protectedTailStartIndex);
        const summarizedThroughMessage = summarizedRows[summarizedRows.length - 1];
        if (!summarizedThroughMessage) {
            if (!isForcedCompaction) {
                break;
            }
            throw new Error(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
        }

        await insertCheckpoint({
            chatId: options.chatId,
            graphPrompt: options.runtime.prompt,
            runtime: options.runtime,
            previousSummary: context.activeSummary,
            basedOnCompactionMessageId: context.activeCompaction?.messageId,
            summarizedMessages: summarizedRows.map((message) => toUIMessage(message)),
            summarizedThroughMessageId: summarizedThroughMessage.id,
            abortSignal: options.abortSignal,
        });

        context = await buildActiveChatContext({
            graphId: options.graphId,
            rows: await loadChatRows(options.chatId),
            runtime: options.runtime,
            systemPrompt,
        });
        options.abortSignal?.throwIfAborted();
    }

    return { context, systemPrompt };
}

export async function ensureChatRecord(options: {
    chatId: string;
    userId: string;
    graphId: string;
    defaultTitle: string;
}) {
    const [insertedChat] = await db
        .insert(chatTable)
        .values({
            id: options.chatId,
            userId: options.userId,
            graphId: options.graphId,
            title: options.defaultTitle,
        })
        .onConflictDoNothing()
        .returning({ id: chatTable.id });

    if (insertedChat) {
        return { isNewChat: true };
    }

    const [existingChat] = await db
        .select({
            id: chatTable.id,
            userId: chatTable.userId,
            graphId: chatTable.graphId,
        })
        .from(chatTable)
        .where(eq(chatTable.id, options.chatId))
        .limit(1);

    if (!existingChat || existingChat.userId !== options.userId || existingChat.graphId !== options.graphId) {
        throw new Error(API_ERROR_CODES.CHAT_NOT_FOUND);
    }

    return { isNewChat: false };
}

export async function createPendingAssistantMessage(chatId: string) {
    const [assistantMessage] = await db
        .insert(messageTable)
        .values({
            chatId,
            role: "assistant",
            status: "pending",
            parts: [],
        })
        .returning({ id: messageTable.id });

    return assistantMessage!.id;
}

export async function syncChatMessage(options: {
    chatId: string;
    message: ChatUIMessage;
    toParts: (message: ChatUIMessage) => MessagePart[];
    getMetrics: (metadata?: ChatMessageMetadata) => {
        tokensPerSecond: number | null;
        timeToFirstToken: number | null;
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
    };
    parseCreatedAt: (value?: string) => Date | undefined;
}) {
    const parts = options.toParts(options.message);
    const createdAt = options.parseCreatedAt(options.message.metadata?.createdAt);
    const metrics = options.getMetrics(options.message.metadata);
    const persistedMessage = {
        role: options.message.role,
        status: "completed" as const,
        parts,
        ...metrics,
    };

    const [syncedMessage] = await db
        .insert(messageTable)
        .values({
            id: options.message.id,
            chatId: options.chatId,
            ...persistedMessage,
            createdAt,
        })
        .onConflictDoUpdate({
            target: messageTable.id,
            set: persistedMessage,
            setWhere: eq(messageTable.chatId, options.chatId),
        })
        .returning({ id: messageTable.id });

    if (!syncedMessage) {
        throw new Error(API_ERROR_CODES.INVALID_CHAT_REQUEST);
    }
}
