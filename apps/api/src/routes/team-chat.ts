import { mapChatError } from "../lib/chat";
import {
    enrichTeamCitation,
    listTeamChats,
    loadTeamChatHistory,
    loadTeamChatSummary,
    refreshTeamReplyContext,
    startTeamReply,
} from "../lib/team-chat";
import { requireTeamAccess } from "../lib/team-access";
import { API_ERROR_CODES, errorResponse } from "../types";
import { createChatTargetRoute } from "./chat-target-route";

type RouteStatus = (code: number, body: unknown) => unknown;

function mapTeamChatError(status: RouteStatus, error: unknown) {
    if (error instanceof Error && error.message === API_ERROR_CODES.TEAM_NOT_FOUND) {
        return status(404, errorResponse("Team not found", API_ERROR_CODES.TEAM_NOT_FOUND));
    }

    return mapChatError(status, error);
}

export const teamChatRoute = createChatTargetRoute({
    prefix: "/teams",
    targetParam: "teamId",
    listPath: "/:teamId/chat",
    itemPath: "/:teamId/chat/:chatId",
    replyPath: "/:teamId/chat",
    streamPath: "/:teamId/stream",
    mapError: mapTeamChatError,
    resolveTarget: requireTeamAccess,
    listChats: (userId, access, options) => listTeamChats(userId, access.team.id, options),
    loadHistory: (userId, access, chatId) => loadTeamChatHistory(userId, access.team.id, chatId),
    loadSummary: (userId, access, chatId) => loadTeamChatSummary(userId, access.team.id, chatId),
    startReply: async ({ user, target: access, request, abortSignal }) => {
        const started = await startTeamReply(user, access.team, request, { abortSignal });

        return {
            chatId: started.chatId,
            assistantId: started.assistantId,
            client: started.client,
            contextMessages: started.contextMessages,
            systemPrompt: started.systemPrompt,
            tools: started.tools,
            isNewChat: started.isNewChat,
            titleMessages: started.titleMessages,
            resolveCitation: (sourceId) => enrichTeamCitation(access.team.id, sourceId, started.citationContext),
            refreshAfterCompaction: async () =>
                refreshTeamReplyContext({
                    chatId: started.chatId,
                    runtime: started,
                    teamName: access.team.name,
                    forceCompaction: true,
                    abortSignal,
                }),
        };
    },
});
