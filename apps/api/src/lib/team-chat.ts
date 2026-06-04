import {
    createChatSystemPrompt,
    getProviderOptions,
    splitTextWithCitationFences,
    toUIMessage,
    uiMessageToMessageParts,
    type ChatMessageMetadata,
    type ChatUIMessage,
    type ChatValidationToolset,
    type ResolvedCitationFence,
} from "@kiwi/ai";
import { prependPromptGuidance } from "@kiwi/ai/prompts/guidance.prompt";
import { db } from "@kiwi/db";
import type { ChatMessage } from "@kiwi/db/tables/chats";
import { filesTable, graphTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { generateText, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AuthUser } from "../middleware/auth";
import type { GraphState } from "../types/routes";
import {
    DEFAULT_CHAT_TITLE,
    enrichCitation,
    getGraphResearchRuntimeWithSharedGuidance,
    getRequiredResearchClient,
    listChatsForTarget,
    listTeamPromptTexts,
    listUserPromptTexts,
    loadChatHistoryForTarget,
    loadChatSummaryForTarget,
    touchChat,
    type ChatRequest,
} from "./chat";
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
    type ChatRuntime,
} from "./chat-compaction";
import {
    createCachingCitationResolver,
    DEFAULT_CITATION_NEGATIVE_CACHE_MAX_ENTRIES,
} from "./chat-citation-normalization";
import { teamChatTarget } from "./chat-target";
import { resolveGraphOwnerRoot } from "./graph-access";

type TeamAccessTeam = {
    id: string;
    name: string;
    organizationId: string;
};

type TeamGraphRow = {
    graph_id: string;
    graph_name: string;
    graph_state: GraphState;
    description: string | null;
};

type TeamChatToolset = ToolSet & ChatValidationToolset;

export type TeamCitationContext = {
    sourceGraphIds: Map<string, string>;
};

type TeamQuestionContext = {
    text: string;
};

type TeamChatRuntime = Omit<ChatRuntime, "tools"> & {
    tools: TeamChatToolset;
    promptGuidance: {
        userPrompts: string[];
        teamPrompts: string[];
    };
    citationContext: TeamCitationContext;
    questionContext: TeamQuestionContext;
};

type TeamGraphRuntime = Pick<TeamChatRuntime, "client" | "promptGuidance">;

const TEAM_CHAT_LIST_DEFAULT_LIMIT = 20;
const TEAM_CHAT_LIST_MAX_LIMIT = 50;
const TEAM_QUERY_GRAPHS_MAX = 10;
const TEAM_CHAT_CONTEXT_MESSAGE_LIMIT = 10;
const unresolvedTeamCitationCache = new Map<string, number>();

function createTeamCitationContext(): TeamCitationContext {
    return { sourceGraphIds: new Map() };
}

function createTeamQuestionContext(rows: ChatMessage[]): TeamQuestionContext {
    return { text: serializeQuestionContext(rows.map((message) => toUIMessage(message))) };
}

function refreshTeamQuestionContext(context: TeamQuestionContext, rows: ChatMessage[]) {
    context.text = serializeQuestionContext(rows.map((message) => toUIMessage(message)));
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

function parseCreatedAt(value?: string) {
    if (!value) {
        return undefined;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function textFromMessage(message: ChatUIMessage) {
    return message.parts
        .filter((part): part is Extract<ChatUIMessage["parts"][number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
}

function serializeQuestionContext(messages: ChatUIMessage[]) {
    const visibleMessages = messages
        .map((message) => ({
            role: message.role,
            text: textFromMessage(message),
        }))
        .filter((message) => message.text.length > 0)
        .slice(-TEAM_CHAT_CONTEXT_MESSAGE_LIMIT);

    return visibleMessages.map((message) => `${message.role}: ${message.text}`).join("\n");
}

function createTeamChatSystemPrompt(teamName: string) {
    return [
        "# Task Context",
        `You are Kiwi, a helpful assistant for answering questions across the graphs in the team "${teamName}".`,
        "Use only the available tools and previously cited chat history. The only tools available here are list_graphs and query_graphs.",
        "list_graphs lists graphs in this team with offset/limit pagination. query_graphs asks specialized graph agents to answer the current user question for selected graph IDs.",
        "",
        "# Retrieval Rules",
        "Use list_graphs before query_graphs unless the relevant graph IDs are already known from this conversation.",
        "For team-wide or all-graph questions, paginate through every graph page and query every relevant graph before answering.",
        "Use query_graphs in batches when more graph IDs are needed than one call allows.",
        "Never invent graph IDs or answer from graph names alone. Use query_graphs for factual claims about graph contents.",
        "",
        "# Citation Rules",
        '- Every citation in the final answer must use this exact literal shape: :::{"type": "cite", "id":"<source-id>"}:::.',
        "- Use only source IDs returned by query_graphs or source IDs already cited earlier in this chat when reusing the same cited information.",
        "- Place citations directly with the claims they support. If no source supports a claim, do not present it as fact.",
        "- Do not output raw tool results, metadata dumps, or lists of IDs.",
        "",
        "# Writing Rules",
        "- Synthesize the graph-agent answers into one concise answer.",
        "- Name graphs naturally when comparing or grouping findings.",
        "- If the team graphs do not contain enough evidence, say that plainly.",
        "- Respond in the same language as the user's question unless the user asks otherwise.",
    ].join("\n");
}

function createGraphAgentTaskPrompt(options: { graphName: string; questionContext: string }) {
    return [
        `Answer the current team-chat question using only this graph: "${options.graphName}".`,
        "",
        "Conversation context:",
        options.questionContext || "(No prior context.)",
        "",
        "Return a concise graph-specific answer. If this graph does not contain relevant evidence, say that no answer was found in this graph.",
        "Use exact citation fences for supporting source IDs. Do not mention other graphs.",
    ].join("\n");
}

function collectCitationSourceIds(text: string) {
    const sourceIds: string[] = [];
    for (const segment of splitTextWithCitationFences(text)) {
        if (segment.type === "citation") {
            sourceIds.push(segment.citation.sourceId);
        }
    }

    return sourceIds;
}

export async function listTeamGraphs(
    teamId: string,
    options: { offset?: number; limit?: number } = {}
): Promise<{ items: TeamGraphRow[]; hasMore: boolean; nextOffset: number | null }> {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(Math.max(1, options.limit ?? TEAM_CHAT_LIST_DEFAULT_LIMIT), TEAM_CHAT_LIST_MAX_LIMIT);

    const rows = await db
        .select({
            graph_id: graphTable.id,
            graph_name: graphTable.name,
            graph_state: graphTable.state,
            description: graphTable.description,
        })
        .from(graphTable)
        .where(and(eq(graphTable.teamId, teamId), isNull(graphTable.graphId), eq(graphTable.hidden, false)))
        .orderBy(asc(graphTable.name), asc(graphTable.id))
        .limit(limit + 1)
        .offset(offset);

    const hasMore = rows.length > limit;
    return {
        items: hasMore ? rows.slice(0, limit) : rows,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
    };
}

async function loadTeamGraphsById(teamId: string, graphIds: string[]) {
    if (graphIds.length === 0) {
        return [];
    }

    return db
        .select({
            graph_id: graphTable.id,
            graph_name: graphTable.name,
            graph_state: graphTable.state,
            description: graphTable.description,
        })
        .from(graphTable)
        .where(
            and(
                eq(graphTable.teamId, teamId),
                isNull(graphTable.graphId),
                eq(graphTable.hidden, false),
                inArray(graphTable.id, graphIds)
            )
        );
}

async function querySingleGraph(options: {
    graph: TeamGraphRow;
    runtime: TeamGraphRuntime;
    questionContext: string;
    abortSignal?: AbortSignal;
}) {
    const runtime = await getGraphResearchRuntimeWithSharedGuidance(options.graph.graph_id, {
        client: options.runtime.client,
        toolset: "server",
        promptGuidance: options.runtime.promptGuidance,
    });

    const result = await generateText({
        model: runtime.client.subagent ?? runtime.client.text,
        system: createChatSystemPrompt({
            includeGraphTools: true,
            includeClientTools: false,
            includeSubagentTools: false,
        }),
        prompt: prependPromptGuidance(
            createGraphAgentTaskPrompt({
                graphName: options.graph.graph_name,
                questionContext: options.questionContext,
            }),
            runtime.promptGuidance
        ),
        tools: runtime.tools,
        temperature: 0.2,
        stopWhen: stepCountIs(50),
        providerOptions: getProviderOptions({ thinking: "medium" }),
        abortSignal: options.abortSignal,
    });

    return {
        graph_id: options.graph.graph_id,
        graph_name: options.graph.graph_name,
        answer: result.text,
        source_ids: [...new Set(collectCitationSourceIds(result.text))],
    };
}

function buildTeamChatToolset(options: {
    team: TeamAccessTeam;
    graphRuntime: TeamGraphRuntime;
    questionContext: TeamQuestionContext;
    citationContext: TeamCitationContext;
}): TeamChatToolset {
    return {
        list_graphs: tool({
            description: "List graphs available in this team with offset/limit pagination.",
            inputSchema: z.object({
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(TEAM_CHAT_LIST_MAX_LIMIT)
                    .default(TEAM_CHAT_LIST_DEFAULT_LIMIT)
                    .describe("Maximum number of graphs to return."),
                offset: z.number().int().min(0).default(0).describe("Zero-based graph offset for pagination."),
            }),
            execute: async ({ limit, offset }) => {
                const result = await listTeamGraphs(options.team.id, { limit, offset });
                return {
                    items: result.items,
                    pagination: {
                        offset,
                        limit,
                        has_more: result.hasMore,
                        next_offset: result.nextOffset,
                    },
                };
            },
        }),
        query_graphs: tool({
            description:
                "Ask specialized graph agents to answer the current user question for the selected team graph IDs. Returns successful answers plus per-graph failures.",
            inputSchema: z.object({
                graph_ids: z
                    .array(z.string().trim().min(1))
                    .min(1)
                    .max(TEAM_QUERY_GRAPHS_MAX)
                    .describe("Graph IDs from list_graphs to query."),
            }),
            execute: async ({ graph_ids }, { abortSignal }) => {
                const uniqueGraphIds = [...new Set(graph_ids)];
                const graphs = await loadTeamGraphsById(options.team.id, uniqueGraphIds);
                const graphById = new Map(graphs.map((graph) => [graph.graph_id, graph]));
                const orderedGraphs = uniqueGraphIds.flatMap((graphId) => {
                    const graph = graphById.get(graphId);
                    return graph ? [graph] : [];
                });
                const missingGraphIds = uniqueGraphIds.filter((graphId) => !graphById.has(graphId));
                const settled = await Promise.allSettled(
                    orderedGraphs.map((graph) =>
                        querySingleGraph({
                            graph,
                            runtime: options.graphRuntime,
                            questionContext: options.questionContext.text,
                            abortSignal,
                        })
                    )
                );
                abortSignal?.throwIfAborted();
                const results = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
                const failedGraphs = settled.flatMap((result, index) => {
                    if (result.status === "fulfilled") {
                        return [];
                    }

                    const graph = orderedGraphs[index]!;
                    return [
                        {
                            graph_id: graph.graph_id,
                            graph_name: graph.graph_name,
                            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                        },
                    ];
                });

                for (const result of results) {
                    for (const sourceId of result.source_ids) {
                        options.citationContext.sourceGraphIds.set(sourceId, result.graph_id);
                    }
                }

                return {
                    results,
                    failed_graphs: failedGraphs,
                    missing_graph_ids: missingGraphIds,
                };
            },
        }),
    } satisfies TeamChatToolset;
}

export async function getTeamChatRuntime(options: {
    user: AuthUser;
    team: TeamAccessTeam;
    questionContext: TeamQuestionContext;
}): Promise<TeamChatRuntime> {
    const [userPrompts, teamPrompts] = await Promise.all([
        listUserPromptTexts(options.user.id),
        listTeamPromptTexts(options.team.id),
    ]);
    const client = getRequiredResearchClient();
    const citationContext = createTeamCitationContext();
    const promptGuidance = {
        userPrompts,
        teamPrompts,
    };

    return {
        client,
        citationContext,
        questionContext: options.questionContext,
        promptGuidance,
        tools: buildTeamChatToolset({
            team: options.team,
            graphRuntime: { client, promptGuidance },
            questionContext: options.questionContext,
            citationContext,
        }),
    };
}

export async function enrichTeamCitation(
    teamId: string,
    sourceId: string,
    citationContext?: TeamCitationContext
): Promise<ResolvedCitationFence | null> {
    const knownGraphId = citationContext?.sourceGraphIds.get(sourceId);
    if (knownGraphId) {
        return enrichCitation(knownGraphId, sourceId);
    }

    const [row] = await db
        .select({
            graphId: filesTable.graphId,
        })
        .from(sourcesTable)
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
        .where(eq(sourcesTable.id, sourceId))
        .limit(1);

    if (!row) {
        return null;
    }

    const rootOwner = await resolveGraphOwnerRoot(row.graphId);
    if (rootOwner.mode !== "team" || rootOwner.teamId !== teamId) {
        return null;
    }

    citationContext?.sourceGraphIds.set(sourceId, row.graphId);
    return enrichCitation(row.graphId, sourceId);
}

function createTeamCitationResolver(teamId: string, citationContext?: TeamCitationContext) {
    return createCachingCitationResolver({
        negativeCache: unresolvedTeamCitationCache,
        negativeCacheMaxEntries: DEFAULT_CITATION_NEGATIVE_CACHE_MAX_ENTRIES,
        negativeCacheKey: (citation) => `${teamId}:${citation.sourceId}`,
        resolveCitation: (sourceId) => enrichTeamCitation(teamId, sourceId, citationContext),
    });
}

export async function refreshTeamReplyContext(options: {
    chatId: string;
    runtime: TeamChatRuntime;
    teamName: string;
    forceCompaction?: boolean;
    abortSignal?: AbortSignal;
}): Promise<{ systemPrompt: string; contextMessages: ModelMessage[]; estimatedPromptTokens: number }> {
    const systemPrompt = prependPromptGuidance(
        createTeamChatSystemPrompt(options.teamName),
        options.runtime.promptGuidance
    );
    const validateMessages = createChatMessageValidator(options.runtime.tools);
    const rows = await loadChatRows(options.chatId);
    refreshTeamQuestionContext(
        options.runtime.questionContext,
        rows.filter((message) => !isCompactionMessage(message))
    );
    const { context } = await maybeCompactConversation({
        chatId: options.chatId,
        runtime: options.runtime,
        rows,
        systemPrompt,
        buildContext: (rows) =>
            buildActiveChatContext({
                rows,
                runtime: options.runtime,
                systemPrompt,
                validateMessages,
            }),
        forceCompaction: options.forceCompaction,
        abortSignal: options.abortSignal,
    });

    return {
        systemPrompt,
        contextMessages: context.contextMessages,
        estimatedPromptTokens: context.estimatedPromptTokens,
    };
}

export async function startTeamReply(
    user: AuthUser,
    team: TeamAccessTeam,
    request: ChatRequest,
    options: { abortSignal?: AbortSignal } = {}
): Promise<
    TeamChatRuntime & {
        chatId: string;
        assistantId: string;
        isNewChat: boolean;
        titleMessages: ChatUIMessage[];
        systemPrompt: string;
        contextMessages: ModelMessage[];
    }
> {
    const normalizedRequest = normalizeChatRequest(request);
    const { isNewChat } = await ensureChatRecord({
        chatId: normalizedRequest.id,
        userId: user.id,
        target: teamChatTarget(team.id),
        defaultTitle: DEFAULT_CHAT_TITLE,
    });
    await syncChatMessage({
        chatId: normalizedRequest.id,
        message: normalizedRequest.latestMessage,
        toParts: uiMessageToMessageParts,
        getMetrics,
        parseCreatedAt,
    });

    const rows = (await loadChatRows(normalizedRequest.id)).filter((message) => !isCompactionMessage(message));
    const questionContext = createTeamQuestionContext(rows);
    const runtime = await getTeamChatRuntime({ user, team, questionContext });
    const { contextMessages, systemPrompt } = await refreshTeamReplyContext({
        chatId: normalizedRequest.id,
        runtime,
        teamName: team.name,
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
        ...runtime,
    };
}

export async function listTeamChats(userId: string, teamId: string, options: { offset?: number; limit?: number } = {}) {
    return listChatsForTarget(userId, teamChatTarget(teamId), options);
}

export async function loadTeamChatSummary(userId: string, teamId: string, chatId: string) {
    return loadChatSummaryForTarget(userId, teamChatTarget(teamId), chatId);
}

export async function loadTeamChatHistory(userId: string, teamId: string, chatId: string) {
    const citationContext = createTeamCitationContext();

    return loadChatHistoryForTarget({
        userId,
        target: teamChatTarget(teamId),
        chatId,
        resolveCitation: createTeamCitationResolver(teamId, citationContext),
        logLabel: "team chat",
    });
}
