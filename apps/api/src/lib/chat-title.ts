import { chatTitlePrompt } from "@kiwi/ai/prompts/title.prompt";
import type { ChatUIMessage, Client } from "@kiwi/ai";
import { db } from "@kiwi/db";
import { chatTable } from "@kiwi/db/tables/chats";
import { error as logError } from "@kiwi/logger";
import { generateText } from "ai";
import { eq, sql } from "drizzle-orm";
import { createChatTitle } from "./chat";

const GENERATED_CHAT_TITLE_MAX_LENGTH = 80;
const CHAT_TITLE_SOURCE_MAX_LENGTH = 2_000;

function getFirstUserText(messages: ChatUIMessage[]) {
    const firstUserMessage = messages.find((message) => message.role === "user");

    return (
        firstUserMessage?.parts
            .filter((part): part is Extract<ChatUIMessage["parts"][number], { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("")
            .replace(/\s+/g, " ")
            .trim() ?? ""
    );
}

function normalizeGeneratedChatTitle(text: string) {
    const title = text
        .replace(/\s+/g, " ")
        .replace(/^title\s*:\s*/i, "")
        .replace(/^[\s"'`]+|[\s"'`.!?]+$/g, "")
        .trim();

    if (title.length === 0) {
        return null;
    }

    return title.length > GENERATED_CHAT_TITLE_MAX_LENGTH
        ? `${title.slice(0, GENERATED_CHAT_TITLE_MAX_LENGTH - 3).trimEnd()}...`
        : title;
}

async function setChatTitle(chatId: string, title: string) {
    await db
        .update(chatTable)
        .set({
            title,
            updatedAt: sql`${chatTable.updatedAt}`,
        })
        .where(eq(chatTable.id, chatId));
}

export function startChatTitleGeneration({
    chatId,
    messages,
    client,
    isNewChat,
}: {
    chatId: string;
    messages: ChatUIMessage[];
    client: Client;
    isNewChat: boolean;
}) {
    if (!isNewChat || !client.text) {
        return;
    }

    const model = client.text;
    const messageText = getFirstUserText(messages).slice(0, CHAT_TITLE_SOURCE_MAX_LENGTH);

    if (messageText.length === 0) {
        void setChatTitle(chatId, createChatTitle(messages)).catch((error) => {
            logError("failed to apply fallback chat title", {
                chatId,
                error,
            });
        });
        return;
    }

    void (async () => {
        const result = await generateText({
            model,
            system: chatTitlePrompt,
            prompt: messageText,
            temperature: 0.2,
        });
        const title = normalizeGeneratedChatTitle(result.text) ?? createChatTitle(messages);

        await setChatTitle(chatId, title);
    })().catch(async (error) => {
        logError("failed to generate chat title", {
            chatId,
            error,
        });
        const fallbackTitle = createChatTitle(messages);
        try {
            await setChatTitle(chatId, fallbackTitle);
        } catch (fallbackError) {
            logError("failed to apply fallback chat title", {
                chatId,
                error: fallbackError,
            });
        }
    });
}
