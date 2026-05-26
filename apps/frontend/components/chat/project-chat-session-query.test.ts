import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchProjectChat, fetchProjectChats } from "@/lib/api/projects";
import { hydrateProjectChatSession, projectChatQueryKey } from "./project-chat-session-query";

vi.mock("@/lib/api/projects", () => ({
    fetchProjectChat: vi.fn(),
    fetchProjectChats: vi.fn(),
}));

const client = {} as never;

describe("project chat session query", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("loads the explicit chat id when one is provided", async () => {
        vi.mocked(fetchProjectChat).mockResolvedValue({
            id: "chat_2",
            title: "Existing chat",
            messages: [],
        } as never);

        await expect(hydrateProjectChatSession(client, "graph_1", "chat_2")).resolves.toEqual({
            id: "chat_2",
            messages: [],
        });

        expect(fetchProjectChats).not.toHaveBeenCalled();
        expect(fetchProjectChat).toHaveBeenCalledWith(client, "graph_1", "chat_2");
    });

    it("falls back to the latest chat when no chat id is provided", async () => {
        vi.mocked(fetchProjectChats).mockResolvedValue([{ id: "chat_1", title: "Latest" }] as never);
        vi.mocked(fetchProjectChat).mockResolvedValue({
            id: "chat_1",
            title: "Latest",
            messages: [],
        } as never);

        await expect(hydrateProjectChatSession(client, "graph_1")).resolves.toEqual({
            id: "chat_1",
            messages: [],
        });

        expect(fetchProjectChats).toHaveBeenCalledWith(client, "graph_1");
        expect(fetchProjectChat).toHaveBeenCalledWith(client, "graph_1", "chat_1");
    });

    it("keys latest and explicit chat sessions separately", () => {
        expect(projectChatQueryKey("graph_1")).toEqual(["project-chat", "graph_1", "latest"]);
        expect(projectChatQueryKey("graph_1", "chat_2")).toEqual(["project-chat", "graph_1", "chat_2"]);
    });
});
