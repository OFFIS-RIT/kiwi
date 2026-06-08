import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

mock.module("@kiwi/db", () => ({
    db: {
        delete: () => ({ where: async () => undefined }),
    },
}));

mock.module("@kiwi/files", () => ({
    deleteFile: async () => undefined,
    listFiles: async () => [],
}));

mock.module("@kiwi/logger", () => ({
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
}));

mock.module("../../env", () => ({
    env: {
        MASTER_USER_ID: undefined,
        S3_BUCKET: "test",
    },
}));

mock.module("../../lib/chat", () => ({
    mapChatError: (status: (code: number, body: unknown) => unknown, error: unknown) => status(500, error),
    setChatArchived: async () => undefined,
    setChatPinned: async () => undefined,
}));

mock.module("../../lib/chat-response", () => ({
    createChatStreamResponse: () => new Response(),
    runChatCompletion: async () => undefined,
}));

mock.module("../../lib/graph", () => ({
    collectGraphClosure: async () => [],
}));

mock.module("../../lib/team-access", () => ({
    requireOrganizationAdmin: async () => ({ organizationId: "org-1" }),
    requireOrganizationMembership: async () => ({ organizationId: "org-1", role: "admin" }),
    requireTeamAccess: async (_user: unknown, teamId: string) => ({
        organizationAdmin: true,
        role: "admin",
        team: { id: teamId, name: "Team", organizationId: "org-1" },
    }),
    requireTeamMemberManageAccess: async (_user: unknown, teamId: string) => ({
        organizationAdmin: true,
        role: "admin",
        team: { id: teamId, name: "Team", organizationId: "org-1" },
    }),
}));

mock.module("../../lib/team-chat", () => ({
    enrichTeamCitation: async () => null,
    listTeamChats: async () => [],
    loadTeamChatHistory: async () => [],
    loadTeamChatSummary: async (_userId: string, _teamId: string, chatId: string) => ({ id: chatId }),
    refreshTeamReplyContext: async () => ({ contextMessages: [], systemPrompt: "" }),
    startTeamReply: async () => ({
        assistantId: "assistant-1",
        chatId: "chat-1",
        client: {},
        contextMessages: [],
        getAdditionalUsage: undefined,
        isNewChat: false,
        systemPrompt: "",
        titleMessages: [],
        tools: {},
    }),
}));

mock.module("../../lib/workflow-cancellation", () => ({
    cancelActiveFileProcessingWorkflowRuns: async () => undefined,
    cancelActiveGraphWorkflowRuns: async () => undefined,
}));

mock.module("../../middleware/auth", () => ({
    authMiddleware: new Elysia({ name: "test-auth" }).derive({ as: "scoped" }, () => ({
        session: null,
        user: null,
    })),
}));

mock.module("../../middleware/permissions", () => ({
    requirePermissions: () => () => undefined,
}));

const { teamChatRoute } = await import("../team-chat");
const { teamRoute } = await import("../team");

describe("team routes", () => {
    test("compose with team chat routes", () => {
        expect(() => new Elysia().use(teamChatRoute).use(teamRoute).compile()).not.toThrow();
    });
});
