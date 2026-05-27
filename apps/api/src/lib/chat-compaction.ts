import {
    buildChatValidationToolset,
    compactConversationHistory,
    createChatSystemPrompt,
    estimateToken,
    prepareCitationFencesForModel,
    chatDataPartSchemas,
    chatMessageMetadataSchema,
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
import { and, asc, eq } from "drizzle-orm";
import { API_ERROR_CODES } from "../types";
import type { ChatRequestBody } from "../types/routes";

const MAX_CONTEXT_TOKENS = 256_000;
const SAFETY_MARGIN_TOKENS = 8_000;
const REPLY_RESERVE_TOKENS = 24_000;
const RAW_TAIL_TARGET_TOKENS = 32_000;
const MIN_RAW_VISIBLE_MESSAGES = 6;
const SOFT_COMPACTION_THRESHOLD = MAX_CONTEXT_TOKENS - SAFETY_MARGIN_TOKENS - REPLY_RESERVE_TOKENS;

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

type ValidationTools = NonNullable<Parameters<typeof validateUIMessages>[0]["tools"]>;

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

function estimateContextTokens(systemPrompt: string, activeSummary: string | undefined, messages: ChatUIMessage[]) {
    const contextMessages = [
        ...(activeSummary ? [createCompactionSystemMessage(activeSummary)] : []),
        ...uiMessagesToModelMessages(messages),
    ];

    return estimateToken(
        JSON.stringify({
            system: systemPrompt,
            messages: contextMessages,
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

export async function loadChatRows(chatId: string) {
    return db.select().from(messageTable).where(eq(messageTable.chatId, chatId)).orderBy(asc(messageTable.createdAt), asc(messageTable.id));
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
    const tools = buildChatValidationToolset({
        graphId: options.graphId,
        embeddingModel: options.runtime.client.embedding,
        model: options.runtime.client.subagent ?? options.runtime.client.text,
        graphPrompt: options.runtime.prompt,
    }) as unknown as ValidationTools;

    return (await validateUIMessages({
        messages: options.rawTailRows.map((message) => toUIMessage(message)),
        tools,
        metadataSchema: chatMessageMetadataSchema,
        dataSchemas: chatDataPartSchemas,
    })) as ChatUIMessage[];
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

    return {
        activeCompaction: compactionState.activeCompaction,
        activeRawTailRows: compactionState.activeRawTailRows,
        validatedMessages,
        contextMessages: [
            ...(activeSummary ? [createCompactionSystemMessage(activeSummary)] : []),
            ...uiMessagesToModelMessages(validatedMessages),
        ],
        activeSummary,
        estimatedPromptTokens: estimateContextTokens(options.systemPrompt, activeSummary, validatedMessages),
    } satisfies ActiveChatContext;
}

function estimateStoredMessageTokens(message: ChatMessage) {
    return estimateToken(JSON.stringify(uiMessagesToModelMessages([toUIMessage(message)])));
}

function shouldCompact(estimatedPromptTokens: number) {
    return (
        estimatedPromptTokens >= SOFT_COMPACTION_THRESHOLD ||
        estimatedPromptTokens + REPLY_RESERVE_TOKENS > MAX_CONTEXT_TOKENS - SAFETY_MARGIN_TOKENS
    );
}

function hasClientToolPart(message: Pick<ChatMessage, "parts">) {
    return message.parts.some((part) => part.type === "tool" && part.execution === "client");
}

function findLatestClientToolIndex(rows: ChatMessage[]) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (hasClientToolPart(rows[index]!)) {
            return index;
        }
    }

    return -1;
}

export function getProtectedTailStartIndex(rows: ChatMessage[]) {
    if (rows.length === 0) {
        return 0;
    }

    let startIndex = rows.length;
    let protectedTokens = 0;

    for (let index = rows.length - 1; index >= 0; index -= 1) {
        startIndex = index;
        protectedTokens += estimateStoredMessageTokens(rows[index]!);

        const protectedCount = rows.length - index;
        if (protectedCount >= MIN_RAW_VISIBLE_MESSAGES && protectedTokens >= RAW_TAIL_TARGET_TOKENS) {
            break;
        }
    }

    const latestClientToolIndex = findLatestClientToolIndex(rows);
    if (latestClientToolIndex !== -1) {
        startIndex = Math.min(startIndex, latestClientToolIndex);
    }

    return startIndex;
}

function serializeCompactionTranscript(messages: ChatUIMessage[]) {
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

                if (part.type === "reasoning" || !("toolCallId" in part) || !("state" in part)) {
                    continue;
                }

                const input = "input" in part && part.input !== undefined ? JSON.stringify(part.input) : undefined;
                const output = "output" in part && part.output !== undefined ? JSON.stringify(part.output) : undefined;
                const errorText = "errorText" in part && part.errorText ? part.errorText : undefined;

                lines.push(`Tool: ${"toolName" in part ? part.toolName : part.type}`);
                lines.push(`State: ${part.state}`);
                if (input) {
                    lines.push(`Input: ${input}`);
                }
                if (output) {
                    lines.push(`Output: ${output}`);
                }
                if (errorText) {
                    lines.push(`Error: ${errorText}`);
                }
            }

            return lines.join("\n");
        })
        .join("\n\n");
}

async function insertCheckpoint(options: {
    chatId: string;
    graphPrompt?: string;
    runtime: ChatRuntime;
    previousSummary?: string;
    basedOnCompactionMessageId?: string;
    summarizedMessages: ChatUIMessage[];
    summarizedThroughMessageId: string;
}) {
    const transcript = serializeCompactionTranscript(options.summarizedMessages);
    const summary = await compactConversationHistory({
        model: options.runtime.client.subagent ?? options.runtime.client.text,
        graphPrompt: options.graphPrompt,
        previousSummary: options.previousSummary,
        transcript,
    });
    const compactionPart: MessageCompactionPart = {
        type: "compaction",
        version: 1,
        summary: prepareCitationFencesForModel(summary.trim()),
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
}) {
    const systemPrompt = createChatSystemPrompt(options.runtime.prompt, options.promptOptions ?? {});
    let context = await buildActiveChatContext({
        graphId: options.graphId,
        rows: options.rows,
        runtime: options.runtime,
        systemPrompt,
    });
    let forceCompaction = options.forceCompaction === true;

    while (forceCompaction || shouldCompact(context.estimatedPromptTokens)) {
        forceCompaction = false;
        const protectedTailStartIndex = getProtectedTailStartIndex(context.activeRawTailRows);
        if (protectedTailStartIndex <= 0) {
            throw new Error(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
        }

        const summarizedRows = context.activeRawTailRows.slice(0, protectedTailStartIndex);
        const summarizedThroughMessage = summarizedRows[summarizedRows.length - 1];
        if (!summarizedThroughMessage) {
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
        });

        context = await buildActiveChatContext({
            graphId: options.graphId,
            rows: await loadChatRows(options.chatId),
            runtime: options.runtime,
            systemPrompt,
        });
    }

    return { context, systemPrompt };
}

export async function ensureChatRecord(options: {
    chatId: string;
    userId: string;
    graphId: string;
    defaultTitle: string;
}) {
    const [existingChat] = await db
        .select({
            id: chatTable.id,
            userId: chatTable.userId,
            graphId: chatTable.graphId,
        })
        .from(chatTable)
        .where(eq(chatTable.id, options.chatId))
        .limit(1);

    if (!existingChat) {
        await db.insert(chatTable).values({
            id: options.chatId,
            userId: options.userId,
            graphId: options.graphId,
            title: options.defaultTitle,
        });
        return { isNewChat: true };
    }

    if (existingChat.userId !== options.userId || existingChat.graphId !== options.graphId) {
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
    const [existing] = await db
        .select({ id: messageTable.id })
        .from(messageTable)
        .where(and(eq(messageTable.chatId, options.chatId), eq(messageTable.id, options.message.id)))
        .limit(1);

    if (existing) {
        await db
            .update(messageTable)
            .set({
                role: options.message.role,
                status: "completed",
                parts,
                ...metrics,
            })
            .where(eq(messageTable.id, options.message.id));
        return;
    }

    await db.insert(messageTable).values({
        id: options.message.id,
        chatId: options.chatId,
        role: options.message.role,
        status: "completed",
        parts,
        createdAt,
        ...metrics,
    });
}
