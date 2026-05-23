import { fetchProjectChat, fetchProjectChats } from "@/lib/api/projects";
import type { KiwiApiClient } from "@/lib/api/client";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { v4 as uuidv4 } from "uuid";

export type ChatSessionState = {
    id: string;
    messages: ChatUIMessage[];
};

export const projectChatQueryKey = (projectId: string) => ["project-chat", projectId] as const;

export async function hydrateProjectChatSession(client: KiwiApiClient, projectId: string): Promise<ChatSessionState> {
    const chats = await fetchProjectChats(client, projectId);
    if (chats.length > 0) {
        const latest = await fetchProjectChat(client, projectId, chats[0].id);
        return { id: latest.id, messages: latest.messages };
    }
    return { id: uuidv4(), messages: [] };
}
