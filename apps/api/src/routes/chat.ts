import {
    enrichCitation,
    listChats,
    loadChatHistory,
    loadChatSummary,
    createUserRequestInformation,
    refreshReplyContext,
    shouldIncludeGraphCorrectionTool,
    startReply as startGraphReply,
} from "../lib/chat";
import { assertCanViewGraphWithRootOwner, type RootOwner } from "../lib/graph/access";
import { createChatTargetRoute } from "./chat-target-route";

type GraphChatTarget = {
    graphId: string;
    rootOwner: RootOwner;
};

export const chatRoute = createChatTargetRoute({
    targetParam: "id",
    listPath: "/chat/:id",
    itemPath: "/chat/:id/:chatId",
    replyPath: "/chat/:id",
    streamPath: "/stream/:id",
    permissions: { graph: ["view"] },
    resolveTarget: async (user, graphId): Promise<GraphChatTarget> => {
        const { rootOwner } = await assertCanViewGraphWithRootOwner(user, graphId);
        return { graphId, rootOwner };
    },
    listChats: (userId, target, options) => listChats(userId, target.graphId, options),
    loadHistory: (userId, target, chatId) => loadChatHistory(userId, target.graphId, chatId),
    loadSummary: (userId, target, chatId) => loadChatSummary(userId, target.graphId, chatId),
    startReply: async ({ user, target, request, mode, abortSignal }) => {
        const deep = request.deep === true;
        const includeCorrectionTool = shouldIncludeGraphCorrectionTool(target.rootOwner, deep);
        const promptOptions = {
            includeGraphTools: !deep,
            includeClientTools: mode === "stream" && !deep,
            includeSubagentTools: deep,
            includeCorrectionTool,
            requestInformation: createUserRequestInformation(user),
        } as const;
        const started = await startGraphReply(user, target.graphId, request, {
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
            refreshAfterCompaction: async () =>
                refreshReplyContext({
                    chatId: started.chatId,
                    graphId: target.graphId,
                    runtime: {
                        client: started.client,
                        tools: started.tools,
                        promptGuidance: started.promptGuidance,
                    },
                    promptOptions,
                    forceCompaction: true,
                    abortSignal,
                }),
        };
    },
});
