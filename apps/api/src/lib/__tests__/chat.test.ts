import { describe, expect, mock, test } from "bun:test";
import { estimateToken, type ChatUIMessage } from "@kiwi/ai";
import type { ChatMessage } from "@kiwi/db/tables/chats";
import { API_ERROR_CODES } from "../../types";

mock.module("@kiwi/db", () => ({
    db: {},
}));

mock.module("../../env", () => ({
    env: {
        AI_TEXT_ADAPTER: "openai",
        AI_TEXT_MODEL: "gpt-test",
        AI_TEXT_KEY: "key",
        AI_TEXT_URL: undefined,
        AI_TEXT_RESOURCE_NAME: undefined,
        AI_SUBAGENT_MODEL: "gpt-subagent",
        AI_EMBEDDING_ADAPTER: "openai",
        AI_EMBEDDING_MODEL: "text-embedding-3-small",
        AI_EMBEDDING_KEY: "key",
        AI_EMBEDDING_URL: undefined,
        AI_EMBEDDING_RESOURCE_NAME: undefined,
    },
}));

const {
    deriveActiveCompaction,
    getProtectedTailStartIndex,
    isContextOverflowError,
    normalizeChatRequest,
    replaceOrAppendMessage,
} = await import("../chat");
const {
    assertCompactionAttemptsRemaining,
    buildActiveChatContext,
    normalizeCompactionSummary,
    serializeCompactionTranscript,
} = await import("../chat-compaction");

const largeText = "token ".repeat(7000);

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

    test("protects the newest client-tool exchange from compaction", () => {
        const rows: ChatMessage[] = Array.from({ length: 10 }, (_, index) =>
            textMessage(`msg-${index + 1}`, index % 2 === 0 ? "user" : "assistant", largeText)
        );

        rows[2] = {
            ...rows[2]!,
            role: "assistant",
            parts: [
                { type: "text", text: largeText },
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

        expect(getProtectedTailStartIndex(rows)).toBe(2);
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

    test("bounds repeated compaction attempts", () => {
        expect(() => assertCompactionAttemptsRemaining(4)).not.toThrow();
        expect(() => assertCompactionAttemptsRemaining(5)).toThrow(API_ERROR_CODES.CHAT_CONTEXT_TOO_LARGE);
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
});
