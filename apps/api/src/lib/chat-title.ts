import { chatTitlePrompt } from "@kiwi/ai/prompts/title.prompt";
import { AI_REQUEST_TIMEOUT, type ChatUIMessage, type Client } from "@kiwi/ai";
import { withAiSlotEffect } from "@kiwi/ai/lock";
import { runDatabaseEffect, tryDbVoid } from "@kiwi/db/effect";
import { chatTable } from "@kiwi/db/tables/chats";
import { error as logError } from "@kiwi/logger";
import { generateText } from "ai";
import { eq, sql } from "@kiwi/db/drizzle";
import * as Effect from "effect/Effect";
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

function setChatTitle(chatId: string, title: string) {
    return tryDbVoid((db) =>
        db
            .update(chatTable)
            .set({
                title,
                updatedAt: sql`${chatTable.updatedAt}`,
            })
            .where(eq(chatTable.id, chatId))
    );
}

function logFallbackTitleFailure(chatId: string, fallbackError: unknown) {
    logError("failed to apply fallback chat title", {
        chatId,
        error: fallbackError,
    });
}

function recoverGeneratedTitleFailure(chatId: string, fallbackTitle: string, error: unknown) {
    return Effect.gen(function* () {
        logError("failed to generate chat title", {
            chatId,
            error,
        });
        yield* Effect.catchTag(setChatTitle(chatId, fallbackTitle), "@kiwi/db/DatabaseError", (fallbackError) =>
            Effect.sync(() => {
                logFallbackTitleFailure(chatId, fallbackError);
            })
        );
    });
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

    const fallbackTitle = createChatTitle(messages);

    if (messageText.length === 0) {
        void runDatabaseEffect(setChatTitle(chatId, fallbackTitle)).catch((error) => {
            logFallbackTitleFailure(chatId, error);
        });
        return;
    }

    const generateAndPersistTitle = Effect.gen(function* () {
        const result = yield* withAiSlotEffect("text", (signal) =>
            generateText({
                model,
                instructions: chatTitlePrompt,
                prompt: messageText,
                temperature: 0.2,
                timeout: AI_REQUEST_TIMEOUT,
                abortSignal: signal,
            })
        );
        const title = normalizeGeneratedChatTitle(result.text) ?? fallbackTitle;

        yield* setChatTitle(chatId, title);
    }).pipe(
        Effect.catchTags({
            AiProviderError: (error) => recoverGeneratedTitleFailure(chatId, fallbackTitle, error),
            "@kiwi/db/DatabaseError": (error) => recoverGeneratedTitleFailure(chatId, fallbackTitle, error),
        })
    );

    void runDatabaseEffect(generateAndPersistTitle).catch((error) => {
        logError("failed to generate chat title", {
            chatId,
            error,
        });
    });
}
