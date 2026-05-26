import { fetchProjectChat } from "@/lib/api/projects";
import type { KiwiApiClient } from "@/lib/api/client";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { v4 as uuidv4 } from "uuid";

export type ChatSessionState = {
    id: string;
    messages: ChatUIMessage[];
};

export const projectChatQueryKey = (projectId: string, chatId?: string | null) =>
    ["project-chat", projectId, chatId ?? "new"] as const;

export async function hydrateProjectChatSession(
    client: KiwiApiClient,
    projectId: string,
    chatId?: string | null
): Promise<ChatSessionState> {
    if (chatId) {
        const chat = await fetchProjectChat(client, projectId, chatId, { suppressNotFoundLog: true });
        return { id: chat.id, messages: chat.messages };
    }

    return { id: uuidv4(), messages: [] };
}
