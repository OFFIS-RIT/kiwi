import {
    compactConversationHistory,
    estimateToken,
    prepareCitationFencesForModel,
    chatDataPartSchemas,
    chatMessageMetadataSchema,
    toModelMessage,
    toUIMessage,
    uiMessagesToModelMessages,
    type ChatMessageMetadata,
    type ChatValidationToolset,
    type ChatUIMessage,
    type Client,
} from "@kiwi/ai";
import type { MessageCompactionPart, MessagePart } from "@kiwi/contracts/chat";
import { db } from "@kiwi/db";
import { chatTable, messageTable, type ChatMessage } from "@kiwi/db/tables/chats";
import type { ScopedPromptGuidance } from "@kiwi/ai/prompts/guidance.prompt";
import { validateUIMessages, type ModelMessage } from "ai";
import { and, asc, eq, ne } from "drizzle-orm";
import { API_ERROR_CODES } from "../types";
import type { ChatRequestBody } from "../types/routes";
import { chatTargetInsertValues, chatTargetMatchesRow, type ChatTarget } from "./chat-target";
import { insertPromptGuidanceMessage } from "./prompt-guidance";

const MAX_RAW_TAIL_TARGET_TOKENS = 32_000;
const MIN_RAW_VISIBLE_MESSAGES = 6;
const SOFT_COMPACTION_THRESHOLD_RATIO = 0.9;
const RAW_TAIL_TARGET_CONTEXT_RATIO = 0.1;
const MAX_COMPACTION_ATTEMPTS = 5;
const MAX_COMPACTION_MODEL_CALLS = 24;
// Each summarization request must leave room for the compaction prompt, the
// previous summary, and the summary output within the compaction model context.
const COMPACTION_CHUNK_CONTEXT_RATIO = 0.9;

export type ChatRequest = ChatRequestBody;

export type NormalizedChatRequest = {
    id: string;
    deep?: boolean;
    modelId?: string;
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
        textModelId: string;
        contextWindow: number;
        compactionContextWindow: number;
    };
    tools: Record<string, unknown>;
    promptGuidance?: ScopedPromptGuidance;
};

export type ActiveChatContext = {
    activeCompaction?: ActiveCompaction;
    activeRawTailRows: ChatMessage[];
    validatedMessages: ChatUIMessage[];
    contextMessages: ModelMessage[];
    activeSummary?: string;
    estimatedPromptTokens: number;
};

export type ChatMessageValidator = (rawTailRows: ChatMessage[]) => Promise<ChatUIMessage[]>;

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

function estimateContextTokens(systemPrompt: string, contextMessages: ModelMessage[], tools?: Record<string, unknown>) {
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
            modelId: request.modelId,
            latestMessage: request.message,
            titleMessages: [request.message],
        };
    }

    if ("messages" in request && request.messages.length > 0) {
        return {
            id: request.id,
            deep: request.deep,
            modelId: request.modelId,
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

export function createChatMessageValidator(tools: ChatValidationToolset): ChatMessageValidator {
    return (rawTailRows) =>
        validateUIMessages<ChatUIMessage>({
            messages: rawTailRows.map((message) => toUIMessage(message)),
            tools,
            metadataSchema: chatMessageMetadataSchema,
            dataSchemas: chatDataPartSchemas,
        });
}

export async function buildActiveChatContext(options: {
    rows: ChatMessage[];
    runtime: ChatRuntime;
    systemPrompt: string;
    validateMessages: ChatMessageValidator;
}) {
    const compactionState = deriveActiveCompaction(options.rows);
    const validatedMessages = await options.validateMessages(compactionState.activeRawTailRows);
    const activeSummary = compactionState.activeCompaction?.part.summary;
    const contextMessages = insertPromptGuidanceMessage(
        [
            ...(activeSummary ? [createCompactionSystemMessage(activeSummary)] : []),
            ...uiMessagesToModelMessages(validatedMessages),
        ],
        options.runtime.promptGuidance
    );

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

export function getSoftCompactionThreshold(contextWindow: number) {
    return Math.max(1, Math.floor(contextWindow * SOFT_COMPACTION_THRESHOLD_RATIO));
}

export function getRawTailTargetTokens(contextWindow: number) {
    return Math.max(1, Math.floor(Math.min(MAX_RAW_TAIL_TARGET_TOKENS, contextWindow * RAW_TAIL_TARGET_CONTEXT_RATIO)));
}

export function getCompactionChunkTokenBudget(contextWindow: number) {
    return Math.max(1, Math.floor(contextWindow * COMPACTION_CHUNK_CONTEXT_RATIO));
}

function shouldCompact(estimatedPromptTokens: number, contextWindow: number) {
    return estimatedPromptTokens >= getSoftCompactionThreshold(contextWindow);
}

export function assertCompactionAttemptsRemaining(attemptCount: number, maxAttempts = MAX_COMPACTION_ATTEMPTS) {
    if (attemptCount >= maxAttempts) {
        throw new Error(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
    }
}

export function assertCompactionModelCallsRemaining(
    completedCallCount: number,
    nextCallCount: number,
    maxCalls = MAX_COMPACTION_MODEL_CALLS
) {
    if (completedCallCount + nextCallCount > maxCalls) {
        throw new Error(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
    }
}

function findTranscriptSplitBoundary(text: string, maxEnd: number) {
    const minimumUsefulBoundary = Math.max(1, Math.floor(maxEnd * 0.6));
    const messageBoundary = text.lastIndexOf("\n\n## Message ", maxEnd);
    if (messageBoundary >= minimumUsefulBoundary) {
        return messageBoundary;
    }

    const paragraphBoundary = text.lastIndexOf("\n\n", maxEnd);
    if (paragraphBoundary >= minimumUsefulBoundary) {
        return paragraphBoundary;
    }

    const lineBoundary = text.lastIndexOf("\n", maxEnd);
    if (lineBoundary >= minimumUsefulBoundary) {
        return lineBoundary;
    }

    const wordBoundary = text.lastIndexOf(" ", maxEnd);
    if (wordBoundary >= minimumUsefulBoundary) {
        return wordBoundary;
    }

    return Math.max(1, maxEnd);
}

function takeTranscriptChunk(text: string, tokenBudget: number) {
    if (estimateToken(text) <= tokenBudget) {
        return { chunk: text, rest: "" };
    }

    let low = 1;
    let high = text.length;
    let bestEnd = 1;

    while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        if (estimateToken(text.slice(0, midpoint)) <= tokenBudget) {
            bestEnd = midpoint;
            low = midpoint + 1;
            continue;
        }

        high = midpoint - 1;
    }

    const splitEnd = findTranscriptSplitBoundary(text, bestEnd);
    return {
        chunk: text.slice(0, splitEnd).trim(),
        rest: text.slice(splitEnd).trimStart(),
    };
}

function splitTranscriptWithinTokenBudget(transcript: string, tokenBudget: number) {
    const chunks: string[] = [];
    let rest = transcript.trim();

    while (rest.length > 0) {
        const next = takeTranscriptChunk(rest, tokenBudget);
        if (next.chunk.length === 0) {
            throw new Error(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
        }

        chunks.push(next.chunk);
        rest = next.rest;
    }

    return chunks;
}

export function createCompactionTranscriptChunks(messages: ChatUIMessage[], tokenBudget: number) {
    return splitTranscriptWithinTokenBudget(serializeCompactionTranscript(messages), tokenBudget);
}

export function getProtectedTailStartIndex(rows: ChatMessage[], contextWindow: number) {
    if (rows.length === 0) {
        return 0;
    }

    let startIndex = rows.length;
    let protectedTokens = 0;
    const minimumProtectedTailStartIndex = Math.max(0, rows.length - MIN_RAW_VISIBLE_MESSAGES);
    const rawTailTargetTokens = getRawTailTargetTokens(contextWindow);

    for (let index = rows.length - 1; index >= 0; index -= 1) {
        startIndex = index;
        protectedTokens += estimateStoredMessageTokens(rows[index]!);

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

async function insertCompactionCheckpoint(options: {
    chatId: string;
    runtime: ChatRuntime;
    previousSummary?: string;
    basedOnCompactionMessageId?: string;
    transcriptChunks: string[];
    summarizedThroughMessageId: string;
    abortSignal?: AbortSignal;
}) {
    let summary = options.previousSummary;

    for (const transcript of options.transcriptChunks) {
        summary = normalizeCompactionSummary(
            await compactConversationHistory({
                model: options.runtime.client.subagent ?? options.runtime.client.text,
                promptGuidance: options.runtime.promptGuidance,
                previousSummary: summary,
                transcript,
                abortSignal: options.abortSignal,
            })
        );
    }

    options.abortSignal?.throwIfAborted();
    if (!summary) {
        throw new Error(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
    }

    const compactionPart: MessageCompactionPart = {
        type: "compaction",
        version: 1,
        summary,
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
    runtime: ChatRuntime;
    rows: ChatMessage[];
    systemPrompt: string;
    buildContext: (rows: ChatMessage[]) => Promise<ActiveChatContext>;
    forceCompaction?: boolean;
    abortSignal?: AbortSignal;
}) {
    let context = await options.buildContext(options.rows);
    let forceCompaction = options.forceCompaction === true;
    let compactionAttempts = 0;
    let compactionModelCalls = 0;
    const contextWindow = options.runtime.client.contextWindow;
    const compactionContextWindow = options.runtime.client.compactionContextWindow;

    if (!forceCompaction && !shouldCompact(context.estimatedPromptTokens, contextWindow)) {
        return { context, systemPrompt: options.systemPrompt };
    }

    const chunkTokenBudget = getCompactionChunkTokenBudget(compactionContextWindow);

    while (forceCompaction || shouldCompact(context.estimatedPromptTokens, contextWindow)) {
        const isForcedCompaction = forceCompaction;
        assertCompactionAttemptsRemaining(compactionAttempts);
        compactionAttempts += 1;
        forceCompaction = false;
        const protectedTailStartIndex = getProtectedTailStartIndex(context.activeRawTailRows, contextWindow);
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

        const transcriptChunks = createCompactionTranscriptChunks(
            summarizedRows.map((message) => toUIMessage(message)),
            chunkTokenBudget
        );
        assertCompactionModelCallsRemaining(compactionModelCalls, transcriptChunks.length);

        await insertCompactionCheckpoint({
            chatId: options.chatId,
            runtime: options.runtime,
            previousSummary: context.activeSummary,
            basedOnCompactionMessageId: context.activeCompaction?.messageId,
            transcriptChunks,
            summarizedThroughMessageId: summarizedThroughMessage.id,
            abortSignal: options.abortSignal,
        });
        compactionModelCalls += transcriptChunks.length;

        context = await options.buildContext(await loadChatRows(options.chatId));
        options.abortSignal?.throwIfAborted();
    }

    return { context, systemPrompt: options.systemPrompt };
}

export async function ensureChatRecord(options: {
    chatId: string;
    userId: string;
    target: ChatTarget;
    defaultTitle: string;
}) {
    const [insertedChat] = await db
        .insert(chatTable)
        .values({
            id: options.chatId,
            userId: options.userId,
            ...chatTargetInsertValues(options.target),
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
            scope: chatTable.scope,
            graphId: chatTable.graphId,
            teamId: chatTable.teamId,
        })
        .from(chatTable)
        .where(eq(chatTable.id, options.chatId))
        .limit(1);

    if (
        !existingChat ||
        existingChat.userId !== options.userId ||
        !chatTargetMatchesRow(existingChat, options.target)
    ) {
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
