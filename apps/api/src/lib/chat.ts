import {
    buildAdapter,
    buildChatValidationToolset,
    buildDeepResearchToolset,
    buildEmbeddingAdapter,
    buildMcpResearchToolset,
    buildServerAndClientToolset,
    buildServerToolset,
    buildSubagentToolset,
    createChatSystemPrompt,
    createRequestInformation,
    getClient,
    isPDFCitation,
    isResolvedCitationFence,
    messagePartsToUIMessage,
    toUIMessage,
    type ChatMessageMetadata,
    type ChatPromptOptions,
    type ChatUIMessage,
    type CorrectionToolContext,
    type CitationFence,
    type GraphToolsetOptions,
    type RequestInformation,
    type ResolvedCitationFence,
    uiMessageToMessageParts,
} from "@kiwi/ai";
import { db } from "@kiwi/db";
import type { MessagePart } from "@kiwi/contracts/chat";
import { chatTable, messageTable, type ChatMessage } from "@kiwi/db/tables/chats";
import { teamPromptsTable, userPromptsTable } from "@kiwi/db/tables/auth";
import { filesTable, graphPromptsTable, processRunsTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { error as logError, warn as logWarn } from "@kiwi/logger";
import { Result } from "better-result";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { env } from "../env";
import { createProjectFileAccessToken } from "./project-file-access-token";
import { getProjectFileProxyUrl } from "./project-file-url";
import {
    buildActiveChatContext,
    createChatMessageValidator,
    createPendingAssistantMessage,
    ensureChatRecord,
    isCompactionMessage,
    loadChatRows,
    maybeCompactConversation,
    normalizeChatRequest,
    syncChatMessage,
    type ChatRequest,
    type ChatRuntime,
} from "./chat-compaction";
import {
    createCachingCitationResolver,
    normalizeMessageCitationFences,
    type CitationResolver,
} from "./chat-citation-normalization";
import {
    chatTargetLogContext,
    chatTargetMatchesRow,
    chatTargetWhere,
    graphChatTarget,
    type ChatTarget,
} from "./chat-target";
import { API_ERROR_CODES, errorResponse } from "../types";
import type { AuthUser } from "../middleware/auth";
import { resolveGraphOwnerRoot, type RootOwner } from "./graph-access";
import { MAX_PROMPTS_PER_SCOPE } from "./prompt-limits";

type RouteStatus = (code: number, body: unknown) => unknown;

export {
    type ChatRequest,
    deriveActiveCompaction,
    getProtectedTailStartIndex,
    normalizeChatRequest,
    replaceOrAppendMessage,
} from "./chat-compaction";

type RuntimeToolset = "server" | "server-and-client" | "mcp";

type ResearchPromptGuidance = {
    userPrompts: string[];
    teamPrompts: string[];
    graphPrompts: string[];
};

type SharedResearchPromptGuidance = Omit<ResearchPromptGuidance, "graphPrompts">;

type StartReplyOptions = {
    toolset: "server" | "server-and-client";
    deep?: boolean;
    rootOwner?: RootOwner;
    promptOptions?: ChatPromptOptions;
    abortSignal?: AbortSignal;
};

type PromptTextRow = {
    prompt: string;
};

export const DEFAULT_CHAT_TITLE = "...";

const unresolvedCitationCache = new Map<string, number>();
const GRAPH_RETRIEVAL_TOOL_NAMES = new Set([
    "list_files",
    "search_entities",
    "list_entities",
    "search_relationships",
    "get_relationships",
    "get_entity_neighbours",
    "get_path_between_entities",
    "get_entity_sources",
    "get_relationship_sources",
    "explore_graph_with_subagent",
    "curate_sources_with_subagent",
]);
const ACKNOWLEDGEMENT_ONLY_PATTERN =
    /^(?:thanks?|thank you|thx|ok(?:ay)?|got it|great|nice|cool|perfect|sounds good|all right|alright|yes|yeah|yep|no|nope)[.!?\s]*$/i;
const CONTEXT_OVERFLOW_PATTERNS = [
    "maximum context length",
    "context window",
    "context_window_exceeded",
    "prompt is too long",
    "input is too long",
    "input length exceeds",
    "too many input tokens",
];

function buildBaseToolset(options: GraphToolsetOptions, toolset: RuntimeToolset) {
    switch (toolset) {
        case "server-and-client":
            return buildServerAndClientToolset(options);
        case "mcp":
            return buildMcpResearchToolset(options);
        case "server":
            return buildServerToolset(options);
    }
}

function normalizePromptTexts(rows: PromptTextRow[]) {
    return rows.map((row) => row.prompt.trim()).filter((prompt) => prompt.length > 0);
}

function getRequestUserName(user: AuthUser) {
    return user.name?.trim() || user.email?.trim() || user.id;
}

export function createUserRequestInformation(user: AuthUser) {
    return createRequestInformation({ userName: getRequestUserName(user) });
}

function hasCompletedGraphRetrieval(message: Pick<ChatMessage, "role" | "parts">) {
    return (
        message.role === "assistant" &&
        message.parts.some(
            (part) =>
                part.type === "tool" &&
                part.status === "completed" &&
                GRAPH_RETRIEVAL_TOOL_NAMES.has(part.toolName)
        )
    );
}

function hasCompletedClarificationResult(message: Pick<ChatMessage, "role" | "parts">) {
    return (
        message.role === "assistant" &&
        message.parts.some(
            (part) =>
                part.type === "tool" &&
                part.status === "completed" &&
                part.toolName === "ask_clarifying_questions"
        )
    );
}

function getMessageOccurredAt(message: Pick<ChatMessage, "createdAt" | "updatedAt">) {
    return message.updatedAt ?? message.createdAt;
}

function getMessageText(message: Pick<ChatMessage, "parts">) {
    return message.parts
        .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
}

function isAcknowledgementOnlyTurn(message: Pick<ChatMessage, "role" | "parts">) {
    if (message.role !== "user") {
        return false;
    }

    const text = getMessageText(message);
    return text.length > 0 && text.length <= 80 && ACKNOWLEDGEMENT_ONLY_PATTERN.test(text);
}

function getLatestGraphRetrievalAt(
    rows: Array<Pick<ChatMessage, "role" | "parts" | "createdAt" | "updatedAt">>
) {
    let latest: Date | null = null;

    for (const row of rows) {
        if (!hasCompletedGraphRetrieval(row)) {
            continue;
        }

        const occurredAt = getMessageOccurredAt(row);
        if (occurredAt && (!latest || occurredAt > latest)) {
            latest = occurredAt;
        }
    }

    return latest;
}

function getLatestReplyTrigger(rows: Array<Pick<ChatMessage, "role" | "parts" | "createdAt" | "updatedAt">>) {
    return [...rows]
        .reverse()
        .find((row) => row.role === "user" || hasCompletedClarificationResult(row));
}

export function shouldRefreshGraphDataAfterCompletedWorkflow(options: {
    rows: Array<Pick<ChatMessage, "role" | "parts" | "createdAt" | "updatedAt">>;
    completedWorkflowAt?: Date | null;
}) {
    if (!options.completedWorkflowAt) {
        return false;
    }

    const latestGraphRetrievalAt = getLatestGraphRetrievalAt(options.rows);
    if (latestGraphRetrievalAt === null || options.completedWorkflowAt <= latestGraphRetrievalAt) {
        return false;
    }

    const latestReplyTrigger = getLatestReplyTrigger(options.rows);
    if (!latestReplyTrigger || isAcknowledgementOnlyTurn(latestReplyTrigger)) {
        return false;
    }

    const latestReplyTriggerAt = getMessageOccurredAt(latestReplyTrigger);

    return latestReplyTriggerAt !== null && latestReplyTriggerAt > latestGraphRetrievalAt;
}

async function getLatestCompletedWorkflowAt(graphId: string) {
    const [run] = await db
        .select({ completedAt: processRunsTable.completedAt })
        .from(processRunsTable)
        .where(
            and(
                eq(processRunsTable.graphId, graphId),
                eq(processRunsTable.status, "completed"),
                isNotNull(processRunsTable.completedAt)
            )
        )
        .orderBy(desc(processRunsTable.completedAt), desc(processRunsTable.id))
        .limit(1);

    return run?.completedAt ?? null;
}

function createGraphDataRefreshNotice(options: {
    rows: ChatMessage[];
    completedWorkflowAt?: Date | null;
}): ChatPromptOptions["graphDataRefresh"] | undefined {
    if (!shouldRefreshGraphDataAfterCompletedWorkflow(options)) {
        return undefined;
    }

    return {
        processedAt: options.completedWorkflowAt?.toISOString(),
    };
}

async function listGraphPromptTexts(graphId: string) {
    return normalizePromptTexts(
        await db
            .select({ prompt: graphPromptsTable.prompt })
            .from(graphPromptsTable)
            .where(eq(graphPromptsTable.graphId, graphId))
            .orderBy(asc(graphPromptsTable.createdAt), asc(graphPromptsTable.id))
            .limit(MAX_PROMPTS_PER_SCOPE)
    );
}

export async function listUserPromptTexts(userId: string) {
    return normalizePromptTexts(
        await db
            .select({ prompt: userPromptsTable.prompt })
            .from(userPromptsTable)
            .where(eq(userPromptsTable.userId, userId))
            .orderBy(asc(userPromptsTable.createdAt), asc(userPromptsTable.id))
            .limit(MAX_PROMPTS_PER_SCOPE)
    );
}

export async function listTeamPromptTexts(teamId: string) {
    return normalizePromptTexts(
        await db
            .select({ prompt: teamPromptsTable.prompt })
            .from(teamPromptsTable)
            .where(eq(teamPromptsTable.teamId, teamId))
            .orderBy(asc(teamPromptsTable.createdAt), asc(teamPromptsTable.id))
            .limit(MAX_PROMPTS_PER_SCOPE)
    );
}

async function listTeamPromptTextsForGraph(graphId: string, knownRootOwner?: RootOwner) {
    const rootOwner = knownRootOwner ?? (await resolveGraphOwnerRoot(graphId));
    if (rootOwner.mode !== "team") {
        return [];
    }

    return listTeamPromptTexts(rootOwner.teamId);
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

export function parseCreatedAt(value?: string) {
    if (!value) {
        return undefined;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function getMetrics(metadata?: ChatMessageMetadata) {
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

export async function touchChat(chatId: string) {
    await db.update(chatTable).set({ updatedAt: new Date() }).where(eq(chatTable.id, chatId));
}

export async function setChatPinned(chatId: string, userId: string, pinned: boolean) {
    await db
        .update(chatTable)
        .set({
            pinnedAt: pinned ? new Date() : null,
            updatedAt: sql`${chatTable.updatedAt}`,
        })
        .where(and(eq(chatTable.id, chatId), eq(chatTable.userId, userId)));
}

export async function setChatArchived(chatId: string, userId: string, archived: boolean) {
    await db
        .update(chatTable)
        .set({
            archivedAt: archived ? new Date() : null,
            // Preserve updatedAt so archive state changes do not reorder chats.
            updatedAt: sql`${chatTable.updatedAt}`,
        })
        .where(and(eq(chatTable.id, chatId), eq(chatTable.userId, userId)));
}

export function getRequiredResearchClient() {
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

    return {
        ...client,
        text: client.text,
        embedding: client.embedding,
    };
}

export type RequiredResearchClient = ReturnType<typeof getRequiredResearchClient>;

function createGraphResearchRuntime(options: {
    graphId: string;
    client: RequiredResearchClient;
    toolset: RuntimeToolset;
    deep?: boolean;
    promptGuidance: ResearchPromptGuidance;
    requestInformation?: RequestInformation;
    correction?: CorrectionToolContext;
}) {
    const toolsetOptions = {
        graphId: options.graphId,
        embeddingModel: options.client.embedding,
        correction: options.correction,
    } satisfies GraphToolsetOptions;
    const baseToolset = buildBaseToolset(toolsetOptions, options.toolset);
    const tools = options.deep
        ? buildDeepResearchToolset(
              buildSubagentToolset({
                  ...toolsetOptions,
                  model: options.client.subagent ?? options.client.text,
                  promptGuidance: options.promptGuidance,
                  requestInformation: options.requestInformation,
              })
          )
        : baseToolset;

    return {
        client: options.client,
        tools,
        promptGuidance: options.promptGuidance,
    };
}

export async function getGraphResearchRuntime(
    graphId: string,
    options: {
        toolset: RuntimeToolset;
        deep?: boolean;
        user?: AuthUser;
        rootOwner?: RootOwner;
        requestInformation?: RequestInformation;
        correction?: CorrectionToolContext;
    } = { toolset: "server" }
) {
    const [graphPrompts, userPrompts, teamPrompts] = await Promise.all([
        listGraphPromptTexts(graphId),
        options.user ? listUserPromptTexts(options.user.id) : [],
        options.user ? listTeamPromptTextsForGraph(graphId, options.rootOwner) : [],
    ]);
    const promptGuidance = {
        userPrompts,
        teamPrompts,
        graphPrompts,
    };

    return createGraphResearchRuntime({
        graphId,
        client: getRequiredResearchClient(),
        toolset: options.toolset,
        deep: options.deep,
        promptGuidance,
        requestInformation: options.requestInformation,
        correction: options.correction,
    });
}

export async function getGraphResearchRuntimeWithSharedGuidance(
    graphId: string,
    options: {
        client: RequiredResearchClient;
        toolset: RuntimeToolset;
        deep?: boolean;
        promptGuidance: SharedResearchPromptGuidance;
        requestInformation?: RequestInformation;
        correction?: CorrectionToolContext;
    }
) {
    return createGraphResearchRuntime({
        graphId,
        client: options.client,
        toolset: options.toolset,
        deep: options.deep,
        promptGuidance: {
            ...options.promptGuidance,
            graphPrompts: await listGraphPromptTexts(graphId),
        },
        requestInformation: options.requestInformation,
        correction: options.correction,
    });
}

export function isContextOverflowError(error: unknown): boolean {
    const messages = [error]
        .flatMap((value) => {
            if (value instanceof Error) {
                return [value.message, value.cause instanceof Error ? value.cause.message : undefined];
            }

            if (typeof value === "object" && value && "message" in value && typeof value.message === "string") {
                return [value.message];
            }

            return [typeof value === "string" ? value : undefined];
        })
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase());

    return messages.some((message) => CONTEXT_OVERFLOW_PATTERNS.some((pattern) => message.includes(pattern)));
}

export function startsAssistantOutput(partType: string) {
    return (
        partType === "text-delta" ||
        partType === "tool-input-start" ||
        partType === "tool-input-delta" ||
        partType === "tool-call" ||
        partType === "tool-result" ||
        partType === "tool-error" ||
        partType === "tool-output-denied" ||
        partType === "tool-approval-request"
    );
}

export async function refreshReplyContext(options: {
    chatId: string;
    graphId: string;
    runtime: ChatRuntime;
    promptOptions?: ChatPromptOptions;
    forceCompaction?: boolean;
    abortSignal?: AbortSignal;
}) {
    const rows = await loadChatRows(options.chatId);
    const latestGraphRetrievalAt = getLatestGraphRetrievalAt(rows);
    const completedWorkflowAt =
        latestGraphRetrievalAt === null ? null : await getLatestCompletedWorkflowAt(options.graphId);
    const graphDataRefresh = createGraphDataRefreshNotice({ rows, completedWorkflowAt });
    const systemPrompt = createChatSystemPrompt({
        ...(options.promptOptions ?? {}),
        ...(graphDataRefresh ? { graphDataRefresh } : {}),
    });
    const validateMessages = createChatMessageValidator(
        buildChatValidationToolset({
            graphId: options.graphId,
            embeddingModel: options.runtime.client.embedding,
            model: options.runtime.client.subagent ?? options.runtime.client.text,
        })
    );
    const buildContext = (rows: ChatMessage[]) =>
        buildActiveChatContext({
            rows,
            runtime: options.runtime,
            systemPrompt,
            validateMessages,
        });
    const { context } = await maybeCompactConversation({
        chatId: options.chatId,
        runtime: options.runtime,
        rows,
        systemPrompt,
        buildContext,
        forceCompaction: options.forceCompaction,
        abortSignal: options.abortSignal,
    });

    return {
        systemPrompt,
        contextMessages: context.contextMessages,
        validatedMessages: context.validatedMessages,
        estimatedPromptTokens: context.estimatedPromptTokens,
    };
}

export async function startReply(user: AuthUser, graphId: string, request: ChatRequest, options: StartReplyOptions) {
    const promptOptions = options.promptOptions ?? {};
    const normalizedRequest = normalizeChatRequest(request);
    const { isNewChat } = await ensureChatRecord({
        chatId: normalizedRequest.id,
        userId: user.id,
        target: graphChatTarget(graphId),
        defaultTitle: DEFAULT_CHAT_TITLE,
    });
    await syncChatMessage({
        chatId: normalizedRequest.id,
        message: normalizedRequest.latestMessage,
        toParts: uiMessageToMessageParts,
        getMetrics,
        parseCreatedAt,
    });
    const runtime = await getGraphResearchRuntime(graphId, {
        ...options,
        user,
        rootOwner: options.rootOwner,
        requestInformation: promptOptions.requestInformation,
        correction: {
            graphId,
            userId: user.id,
            chatId: normalizedRequest.id,
            messageId: normalizedRequest.latestMessage.id,
        },
    });
    const { contextMessages, validatedMessages, estimatedPromptTokens, systemPrompt } = await refreshReplyContext({
        chatId: normalizedRequest.id,
        graphId,
        runtime,
        promptOptions,
        abortSignal: options.abortSignal,
    });
    const assistantId = await createPendingAssistantMessage(normalizedRequest.id);
    await touchChat(normalizedRequest.id);

    return {
        chatId: normalizedRequest.id,
        assistantId,
        isNewChat,
        titleMessages: normalizedRequest.titleMessages,
        systemPrompt,
        contextMessages,
        validatedMessages,
        estimatedPromptTokens,
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
    return createCachingCitationResolver({
        negativeCache: unresolvedCitationCache,
        negativeCacheKey: (citation) => `${graphId}:${citation.sourceId}`,
        resolveCitation: (sourceId) => enrichCitation(graphId, sourceId),
    });
}

export async function updateMessagePartsBatch(chatId: string, updates: Array<{ id: string; parts: MessagePart[] }>) {
    if (updates.length === 0) {
        return;
    }

    const cases = sql.join(
        updates.map(
            (update) => sql`when ${messageTable.id} = ${update.id} then ${JSON.stringify(update.parts)}::jsonb`
        ),
        sql.raw(" ")
    );

    await db
        .update(messageTable)
        .set({ parts: sql<MessagePart[]>`case ${cases} else ${messageTable.parts} end` })
        .where(
            and(
                eq(messageTable.chatId, chatId),
                inArray(
                    messageTable.id,
                    updates.map((update) => update.id)
                )
            )
        );
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

export async function loadChatSummaryForTarget(userId: string, target: ChatTarget, chatId: string) {
    const [chat] = await db
        .select({
            id: chatTable.id,
            title: chatTable.title,
            userId: chatTable.userId,
            scope: chatTable.scope,
            graphId: chatTable.graphId,
            teamId: chatTable.teamId,
        })
        .from(chatTable)
        .where(eq(chatTable.id, chatId))
        .limit(1);

    if (!chat || chat.userId !== userId || !chatTargetMatchesRow(chat, target)) {
        throw new Error(API_ERROR_CODES.CHAT_NOT_FOUND);
    }

    return {
        id: chat.id,
        title: chat.title,
    };
}

export async function loadChatSummary(userId: string, graphId: string, chatId: string) {
    return loadChatSummaryForTarget(userId, graphChatTarget(graphId), chatId);
}

export async function loadChatHistoryForTarget(options: {
    userId: string;
    target: ChatTarget;
    chatId: string;
    resolveCitation: CitationResolver;
    logLabel: string;
}) {
    const chat = await loadChatSummaryForTarget(options.userId, options.target, options.chatId);
    const logContext = chatTargetLogContext(options.target);

    const rows = (await loadChatRows(options.chatId, { includeFailed: true })).filter(
        (message) => !isCompactionMessage(message)
    );

    const normalizedRows = await Promise.all(
        rows.map(async (message) => {
            const normalizedResult = await Result.tryPromise(async () =>
                normalizeMessageCitationFences(message.parts, options.resolveCitation)
            );
            if (normalizedResult.isErr()) {
                logError(`failed to normalize ${options.logLabel} citations`, {
                    ...logContext,
                    chatId: options.chatId,
                    messageId: message.id,
                    error: normalizedResult.error,
                });

                return {
                    message,
                    normalized: {
                        parts: message.parts,
                        changed: false,
                        unresolvedCitations: [],
                    },
                };
            }

            const normalized = normalizedResult.value;
            if (normalized.unresolvedCitations.length > 0) {
                logWarn(`${options.logLabel} citation normalization hid unresolved citations without persisting`, {
                    ...logContext,
                    chatId: options.chatId,
                    messageId: message.id,
                    unresolvedCitationCount: normalized.unresolvedCitations.length,
                    sourceIds: normalized.unresolvedCitations.map((citation) => citation.sourceId).join(","),
                });
            }

            return {
                message,
                normalized,
            };
        })
    );

    const messagePartUpdates = normalizedRows.flatMap(({ message, normalized }) =>
        normalized.changed && normalized.unresolvedCitations.length === 0
            ? [{ id: message.id, parts: normalized.parts }]
            : []
    );

    const writeResult = await Result.tryPromise(async () =>
        updateMessagePartsBatch(options.chatId, messagePartUpdates)
    );
    if (writeResult.isErr()) {
        logError(`failed to persist normalized ${options.logLabel} citations`, {
            ...logContext,
            chatId: options.chatId,
            error: writeResult.error,
        });
    }

    const messages = normalizedRows.map(({ message, normalized }) =>
        toUIMessage({
            ...message,
            parts: normalized.parts,
        })
    );

    return {
        id: chat.id,
        title: chat.title,
        messages,
    };
}

export async function loadChatHistory(userId: string, graphId: string, chatId: string) {
    return loadChatHistoryForTarget({
        userId,
        target: graphChatTarget(graphId),
        chatId,
        resolveCitation: createCachedCitationResolver(graphId),
        logLabel: "chat",
    });
}

export async function listChatsForTarget(
    userId: string,
    target: ChatTarget,
    options: { offset?: number; limit?: number } = {}
) {
    const baseQuery = db
        .select({
            id: chatTable.id,
            title: chatTable.title,
            isPinned: sql<boolean>`false`,
            updatedAt: chatTable.updatedAt,
        })
        .from(chatTable)
        .where(
            and(
                eq(chatTable.userId, userId),
                chatTargetWhere(target),
                isNull(chatTable.archivedAt),
                isNull(chatTable.pinnedAt)
            )
        )
        .orderBy(desc(chatTable.updatedAt), desc(chatTable.id));

    const effectiveLimit = typeof options.limit === "number" && options.limit > 0 ? options.limit + 1 : undefined;

    const rows = await (typeof effectiveLimit === "number"
        ? typeof options.offset === "number" && options.offset > 0
            ? baseQuery.limit(effectiveLimit).offset(options.offset)
            : baseQuery.limit(effectiveLimit)
        : typeof options.offset === "number" && options.offset > 0
          ? baseQuery.offset(options.offset)
          : baseQuery);

    const hasMore = typeof options.limit === "number" && options.limit > 0 ? rows.length > options.limit : false;
    const items = (hasMore ? rows.slice(0, options.limit) : rows).map((row) => ({
        id: row.id,
        title: row.title,
        isPinned: row.isPinned,
        updatedAt: row.updatedAt?.toISOString() ?? null,
    }));

    return {
        items,
        hasMore,
    };
}

export async function listChats(userId: string, graphId: string, options: { offset?: number; limit?: number } = {}) {
    return listChatsForTarget(userId, graphChatTarget(graphId), options);
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

    if (hasErrorCode(API_ERROR_CODES.INVALID_CHAT_REQUEST)) {
        return status(400, errorResponse("Invalid chat request", API_ERROR_CODES.INVALID_CHAT_REQUEST));
    }

    if (hasErrorCode(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE)) {
        return status(
            413,
            errorResponse(
                "Chat context is too large to continue without losing the protected recent tail",
                API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE
            )
        );
    }

    return status(500, errorResponse(error.message || "Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
}
