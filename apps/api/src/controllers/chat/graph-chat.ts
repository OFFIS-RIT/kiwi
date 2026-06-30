import * as Effect from "effect/Effect";
import {
    createUserRequestInformation,
    enrichCitation,
    listChats,
    loadChatHistory,
    loadChatSummary,
    refreshReplyContext,
    shouldIncludeGraphCorrectionTool,
    startReply as startGraphReply,
} from "../../lib/chat";
import { assertCanViewGraphWithRootOwner, type RootOwner } from "../../lib/graph/access";
import type { ChatRouteSpec } from "./target-route";

type GraphChatTarget = {
    graphId: string;
    rootOwner: RootOwner;
};

export const graphChatTargetSpec: ChatRouteSpec<GraphChatTarget> = {
    targetParam: "id",
    listPath: "/chat/:id",
    itemPath: "/chat/:id/:chatId",
    replyPath: "/chat/:id",
    streamPath: "/stream/:id",
    permissions: { graph: ["view"] },
    resolveTarget: (user, graphId) =>
        Effect.map(assertCanViewGraphWithRootOwner(user, graphId), ({ rootOwner }) => ({ graphId, rootOwner })),
    listChats: (userId, target, options) => listChats(userId, target.graphId, options),
    loadHistory: (userId, target, chatId) => loadChatHistory(userId, target.graphId, chatId),
    loadSummary: (userId, target, chatId) => loadChatSummary(userId, target.graphId, chatId),
    startReply: ({ user, target, request, mode, abortSignal }) =>
        Effect.gen(function* () {
            const deep = request.deep === true;
            const includeCorrectionTool = shouldIncludeGraphCorrectionTool(target.rootOwner, deep);
            const promptOptions = {
                includeGraphTools: !deep,
                includeClientTools: mode === "stream" && !deep,
                includeSubagentTools: deep,
                includeCorrectionTool,
                requestInformation: createUserRequestInformation(user),
            } as const;
            const started = yield* startGraphReply(user, target.graphId, request, {
                toolset: mode === "stream" ? "server-and-client" : "server",
                deep,
                rootOwner: target.rootOwner,
                promptOptions,
                abortSignal,
            });

            return {
                chatId: started.chatId,
                assistantId: started.assistantId,
                client: started.client,
                contextMessages: started.contextMessages,
                systemPrompt: started.systemPrompt,
                tools: started.tools,
                isNewChat: started.isNewChat,
                titleMessages: started.titleMessages,
                resolveCitation: (sourceId) => enrichCitation(target.graphId, sourceId),
                refreshAfterCompaction: () =>
                    refreshReplyContext({
                        chatId: started.chatId,
                        graphId: target.graphId,
                        runtime: {
                            client: started.client,
                            tools: started.tools,
                            promptGuidance: started.promptGuidance,
                        },
                        promptOptions: { ...promptOptions, includeCodeSearchTool: Boolean(started.tools.code_search) },
                        forceCompaction: true,
                        abortSignal,
                    }),
            };
        }),
};
