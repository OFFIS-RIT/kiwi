import { describe, expect, mock, test } from "bun:test";
import type { ChatUIMessage } from "@kiwi/ai";
import type { ChatMessage } from "@kiwi/db/tables/chats";
import { API_ERROR_CODES } from "../../types";

const dbMock: { insert?: ReturnType<typeof mock> } = {};
const envMock = {
    AI_TEXT_ADAPTER: "openai",
    AI_TEXT_MODEL: "gpt-test",
    CONTEXT_WINDOW: 250_000,
    AI_TEXT_KEY: "key",
    AI_TEXT_URL: undefined,
    AI_TEXT_RESOURCE_NAME: undefined,
    AI_SUBAGENT_MODEL: "gpt-subagent",
    AI_EMBEDDING_ADAPTER: "openai",
    AI_EMBEDDING_MODEL: "text-embedding-3-small",
    AI_EMBEDDING_KEY: "key",
    AI_EMBEDDING_URL: undefined,
    AI_EMBEDDING_RESOURCE_NAME: undefined,
};

mock.module("@kiwi/db", () => ({
    db: dbMock,
}));

mock.module("../../env", () => ({
    env: envMock,
}));

const { estimateToken } = await import("@kiwi/ai");
const {
    deriveActiveCompaction,
    getProtectedTailStartIndex,
    isContextOverflowError,
    normalizeChatRequest,
    replaceOrAppendMessage,
    startsAssistantOutput,
} = await import("../chat");
const {
    assertCompactionAttemptsRemaining,
    buildActiveChatContext,
    getRawTailTargetTokens,
    getSoftCompactionThreshold,
    maybeCompactConversation,
    normalizeCompactionSummary,
    serializeCompactionTranscript,
    syncChatMessage,
} = await import("../chat-compaction");

function textMessage(id: string, role: "user" | "assistant" | "system", text: string) {
    return {
        id,
        chatId: "chat-1",
        status: "completed" as const,
        role,
        parts: [{ type: "text" as const, text }],
        tokensPerSecond: null,
        timeToFirstToken: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
}

function answeredClarificationMessage(message: ChatMessage): ChatMessage {
    return {
        ...message,
        role: "assistant",
        parts: [
            { type: "text", text: "Checking the clarification answer." },
            {
                type: "tool",
                toolCallId: "tool-1",
                toolName: "ask_clarifying_questions",
                execution: "client",
                status: "completed",
                args: { questions: ["Which region?"] },
                result: { answers: ["EMEA"] },
            },
        ],
    };
}

describe("chat request normalization", () => {
    test("uses the explicit latest message request shape", () => {
        const latestMessage = {
            id: "msg-1",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "hello" }],
        };

        expect(
            normalizeChatRequest({
                id: "chat-1",
                message: latestMessage,
            })
        ).toMatchObject({
            id: "chat-1",
            latestMessage,
            titleMessages: [latestMessage],
        });
    });

    test("uses the last message from the compatibility request shape", () => {
        const firstMessage = {
            id: "msg-1",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "hello" }],
        };
        const latestMessage = {
            id: "msg-2",
            role: "assistant" as const,
            parts: [{ type: "text" as const, text: "world" }],
        };

        expect(
            normalizeChatRequest({
                id: "chat-1",
                messages: [firstMessage, latestMessage],
            })
        ).toMatchObject({
            latestMessage,
            titleMessages: [firstMessage, latestMessage],
        });
    });
});

describe("chat context helpers", () => {
    test("replaces an existing message by id when client tool output mutates it", () => {
        expect(
            replaceOrAppendMessage(
                [
                    { id: "msg-1", value: "first" },
                    { id: "msg-2", value: "stale" },
                ],
                { id: "msg-2", value: "fresh" }
            )
        ).toEqual([
            { id: "msg-1", value: "first" },
            { id: "msg-2", value: "fresh" },
        ]);
    });

    test("uses only the newest compaction checkpoint for active context", () => {
        const rows = [
            textMessage("msg-1", "user", "hello"),
            textMessage("msg-2", "assistant", "first answer"),
            {
                ...textMessage("cmp-1", "system", ""),
                parts: [
                    {
                        type: "compaction" as const,
                        version: 1 as const,
                        summary: "summary-1",
                        summarizedThroughMessageId: "msg-2",
                    },
                ],
            },
            textMessage("msg-3", "user", "follow up"),
            textMessage("msg-4", "assistant", "second answer"),
            {
                ...textMessage("cmp-2", "system", ""),
                parts: [
                    {
                        type: "compaction" as const,
                        version: 1 as const,
                        summary: "summary-2",
                        summarizedThroughMessageId: "msg-4",
                        basedOnCompactionMessageId: "cmp-1",
                    },
                ],
            },
            textMessage("msg-5", "user", "latest question"),
        ];

        const context = deriveActiveCompaction(rows);

        expect(context.activeCompaction).toEqual({
            messageId: "cmp-2",
            part: {
                type: "compaction",
                version: 1,
                summary: "summary-2",
                summarizedThroughMessageId: "msg-4",
                basedOnCompactionMessageId: "cmp-1",
            },
        });
        expect(context.activeRawTailRows.map((message) => message.id)).toEqual(["msg-5"]);
    });

    test("keeps the natural protected tail when the latest message has a client-tool result", () => {
        const rows: ChatMessage[] = Array.from({ length: 10 }, (_, index) =>
            textMessage(`msg-${index + 1}`, index % 2 === 0 ? "user" : "assistant", `short ${index + 1}`)
        );

        rows[9] = answeredClarificationMessage(rows[9]!);

        const protectedTailStartIndex = getProtectedTailStartIndex(rows);

        expect(protectedTailStartIndex).toBe(4);
        expect(rows.slice(protectedTailStartIndex).map((message) => message.id)).toContain("msg-10");
    });

    test("allows older completed client-tool exchanges to be compacted after newer messages exist", () => {
        const rows: ChatMessage[] = Array.from({ length: 10 }, (_, index) =>
            textMessage(`msg-${index + 1}`, index % 2 === 0 ? "user" : "assistant", `short ${index + 1}`)
        );

        rows[2] = answeredClarificationMessage(rows[2]!);

        expect(getProtectedTailStartIndex(rows)).toBe(4);
    });

    test("falls back to the minimum protected tail when messages stay below the raw tail token target", () => {
        const rows: ChatMessage[] = Array.from({ length: 10 }, (_, index) =>
            textMessage(`msg-${index + 1}`, index % 2 === 0 ? "user" : "assistant", `short ${index + 1}`)
        );

        expect(getProtectedTailStartIndex(rows)).toBe(4);
    });

    test("keeps db-shaped tool parts in the compaction transcript even without AI SDK state fields", () => {
        const transcript = serializeCompactionTranscript([
            {
                id: "msg-1",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        toolCallId: "tool-1",
                        toolName: "ask_clarifying_questions",
                        status: "completed",
                        args: { questions: ["Which region?"] },
                        result: { answers: ["EMEA"] },
                    },
                ],
            } as unknown as ChatUIMessage,
        ]);

        expect(transcript).toContain("Tool: ask_clarifying_questions");
        expect(transcript).toContain("State: completed");
        expect(transcript).toContain('Input: {"questions":["Which region?"]}');
        expect(transcript).toContain('Output: {"answers":["EMEA"]}');
    });

    test("rejects empty compaction summaries instead of silently checkpointing them", () => {
        expect(() => normalizeCompactionSummary("   \n\t  ")).toThrow("Compaction summary was empty");
    });

    test("detects provider context overflow errors for retry-after-compaction", () => {
        expect(
            isContextOverflowError(new Error("This model's maximum context length is 256000 tokens."))
        ).toBe(true);
        expect(
            isContextOverflowError({
                message: "context_window_exceeded: input length exceeds the context window",
            })
        ).toBe(true);
        expect(isContextOverflowError(new Error("Temporary upstream failure"))).toBe(false);
    });

    test("does not treat lifecycle-only stream events as retry boundaries", () => {
        expect(startsAssistantOutput("start-step")).toBe(false);
        expect(startsAssistantOutput("finish-step")).toBe(false);
        expect(startsAssistantOutput("text-start")).toBe(false);
        expect(startsAssistantOutput("reasoning-start")).toBe(false);
        expect(startsAssistantOutput("text-delta")).toBe(true);
        expect(startsAssistantOutput("reasoning-delta")).toBe(false);
        expect(startsAssistantOutput("tool-input-start")).toBe(true);
        expect(startsAssistantOutput("start")).toBe(false);
        expect(startsAssistantOutput("error")).toBe(false);
    });

    test("bounds repeated compaction attempts", () => {
        expect(() => assertCompactionAttemptsRemaining(4)).not.toThrow();
        expect(() => assertCompactionAttemptsRemaining(5)).toThrow(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
    });

    test("keeps the protected tail target below the soft threshold for smaller context windows", () => {
        expect(getSoftCompactionThreshold(32_000)).toBe(22_400);
        expect(getRawTailTargetTokens(32_000)).toBeLessThan(getSoftCompactionThreshold(32_000));
        expect(getRawTailTargetTokens(250_000)).toBe(32_000);
    });

    test("does not turn the soft threshold into a hard failure when only protected tail remains", async () => {
        const originalContextWindow = envMock.CONTEXT_WINDOW;
        envMock.CONTEXT_WINDOW = 100;
        dbMock.insert = mock(() => {
            throw new Error("soft compaction should not insert a checkpoint");
        });

        try {
            const rows: ChatMessage[] = Array.from({ length: 6 }, (_, index) =>
                textMessage(`msg-soft-${index + 1}`, index % 2 === 0 ? "user" : "assistant", "token ".repeat(30))
            );

            await expect(
                maybeCompactConversation({
                    chatId: "chat-1",
                    graphId: "graph-1",
                    rows,
                    runtime: {
                        client: {
                            text: {} as never,
                            embedding: {} as never,
                        },
                        tools: {},
                    },
                })
            ).resolves.toHaveProperty("context");

            expect(dbMock.insert).not.toHaveBeenCalled();
        } finally {
            envMock.CONTEXT_WINDOW = originalContextWindow;
            dbMock.insert = undefined;
        }
    });

    test("keeps forced compaction strict when the protected tail cannot be reduced", async () => {
        const originalContextWindow = envMock.CONTEXT_WINDOW;
        envMock.CONTEXT_WINDOW = 100;
        try {
            const rows: ChatMessage[] = Array.from({ length: 6 }, (_, index) =>
                textMessage(`msg-forced-${index + 1}`, index % 2 === 0 ? "user" : "assistant", "token ".repeat(30))
            );

            await expect(
                maybeCompactConversation({
                    chatId: "chat-1",
                    graphId: "graph-1",
                    rows,
                    runtime: {
                        client: {
                            text: {} as never,
                            embedding: {} as never,
                        },
                        tools: {},
                    },
                    forceCompaction: true,
                })
            ).rejects.toThrow(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
        } finally {
            envMock.CONTEXT_WINDOW = originalContextWindow;
        }
    });

    test("includes tool definitions in the prompt token estimate", async () => {
        const runtime = {
            client: {
                text: {} as never,
                embedding: {} as never,
            },
            tools: {
                ask_clarifying_questions: {
                    description: "Ask follow-up questions",
                    inputSchema: { type: "object" },
                },
            },
        };

        const context = await buildActiveChatContext({
            graphId: "graph-1",
            rows: [textMessage("msg-tool-estimate", "user", "hello")],
            runtime,
            systemPrompt: "system prompt",
        });

        expect(context.estimatedPromptTokens).toBe(
            estimateToken(
                JSON.stringify({
                    system: "system prompt",
                    messages: context.contextMessages,
                    tools: runtime.tools,
                })
            )
        );
    });

    test("rejects a latest message id that belongs to another chat", async () => {
        const returning = mock(async () => []);
        const onConflictDoUpdate = mock(() => ({ returning }));
        const values = mock(() => ({ onConflictDoUpdate }));
        const insert = mock(() => ({ values }));
        dbMock.insert = insert;

        await expect(
            syncChatMessage({
                chatId: "chat-1",
                message: {
                    id: "msg-cross-chat",
                    role: "user",
                    parts: [{ type: "text", text: "hello" }],
                },
                toParts: () => [{ type: "text", text: "hello" }],
                getMetrics: () => ({
                    tokensPerSecond: null,
                    timeToFirstToken: null,
                    inputTokens: null,
                    outputTokens: null,
                    totalTokens: null,
                }),
                parseCreatedAt: () => undefined,
            })
        ).rejects.toThrow(API_ERROR_CODES.INVALID_CHAT_REQUEST);

        expect(onConflictDoUpdate).toHaveBeenCalled();
        dbMock.insert = undefined;
    });
});
