import { describe, expect, mock, test } from "bun:test";
import { simulateReadableStream, validateUIMessages } from "ai";

mock.module("@kiwi/db", () => ({
    db: {},
}));

const {
    buildChatValidationToolset,
    chatDataPartSchemas,
    chatMessageMetadataSchema,
    createCitationFenceStreamParser,
    messagePartsToUIMessage,
    parseCitationFence,
    splitTextWithCitationFences,
    stringifyCitationFence,
    toUIMessage,
    uiMessageToMessageParts,
} = await import("../chat");
const { toModelMessage } = await import("../index");

function mergeTextSegments<T extends { type: string } & Record<string, unknown>>(segments: T[]) {
    return segments.reduce<T[]>((merged, segment) => {
        const previous = merged[merged.length - 1];
        if (segment.type === "text" && previous?.type === "text") {
            merged[merged.length - 1] = {
                ...previous,
                text: `${String(previous.text ?? "")}${String(segment.text ?? "")}`,
            } as T;
            return merged;
        }

        merged.push(segment);
        return merged;
    }, []);
}

describe("citation fences", () => {
    test("repairs malformed citation JSON", () => {
        expect(parseCitationFence(":::{ type: 'cite', id: 'src_1' }:::")).toEqual({
            type: "cite",
            sourceId: "src_1",
        });
    });

    test("splits complete text into text and citation segments", () => {
        expect(mergeTextSegments(splitTextWithCitationFences("Alpha :::{type:'cite',id:'src_1'}::: Omega"))).toEqual([
            { type: "text", text: "Alpha " },
            {
                type: "citation",
                citation: { type: "cite", sourceId: "src_1" },
            },
            { type: "text", text: " Omega" },
        ]);
    });

    test("drops invalid fences", () => {
        expect(
            mergeTextSegments(splitTextWithCitationFences("Alpha :::{ type: 'note', id: 'src_1' }::: Omega"))
        ).toEqual([{ type: "text", text: "Alpha  Omega" }]);
    });

    test("drops unfinished fences on flush", () => {
        const parser = createCitationFenceStreamParser();

        expect(parser.push("Alpha :::{ type: 'cite'")).toEqual([{ type: "text", text: "Alpha " }]);
        expect(parser.flush()).toEqual([]);
    });

    test("parses citation fences across streamed chunks", async () => {
        const parser = createCitationFenceStreamParser();
        const stream = simulateReadableStream({
            chunks: ["Alpha ::", ":{ type: 'cite',", " id: 'src_1' }:::", " Omega"],
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
        });
        const segments: ReturnType<typeof parser.push> = [];

        for await (const chunk of stream) {
            segments.push(...parser.push(chunk));
        }

        segments.push(...parser.flush());

        expect(mergeTextSegments(segments)).toEqual([
            { type: "text", text: "Alpha " },
            {
                type: "citation",
                citation: { type: "cite", sourceId: "src_1" },
            },
            { type: "text", text: " Omega" },
        ]);
    });

    test("handles adjacent citation fences in one stream", async () => {
        const parser = createCitationFenceStreamParser();
        const stream = simulateReadableStream({
            chunks: [":::{ type: 'cite', id: 'src_1' }::::::{ type: 'cite', id: 'src_2' }:::"],
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
        });
        const segments: ReturnType<typeof parser.push> = [];

        for await (const chunk of stream) {
            segments.push(...parser.push(chunk));
        }

        segments.push(...parser.flush());

        expect(segments).toEqual([
            {
                type: "citation",
                citation: { type: "cite", sourceId: "src_1" },
            },
            {
                type: "citation",
                citation: { type: "cite", sourceId: "src_2" },
            },
        ]);
    });

    test("keeps enriched citation fences inline while round-tripping tool parts", () => {
        const citationFence = stringifyCitationFence({
            type: "cite",
            sourceId: "src-1",
            unitId: "unit-1",
            fileName: "document.pdf",
            fileKey: "graphs/g1/document.pdf",
        });

        const uiMessage = messagePartsToUIMessage(
            {
                id: "msg-1",
                role: "assistant",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                parts: [
                    { type: "text", text: `Answer ${citationFence}` },
                    {
                        type: "tool",
                        toolCallId: "tool-1",
                        toolName: "ask_clarifying_questions",
                        execution: "client",
                        status: "completed",
                        args: { questions: ["Which region?"] },
                        result: { answers: ["EMEA"] },
                    },
                    {
                        type: "metadata",
                        metadata: {
                            totalTokens: 42,
                            durationMs: 900,
                        },
                    },
                ],
            },
            { modelId: "gpt-test" }
        );

        expect(uiMessage.metadata?.createdAt).toBe("2026-01-01T00:00:00.000Z");
        expect(uiMessage.metadata?.totalTokens).toBe(42);
        expect(uiMessage.parts).toEqual([
            { type: "text", text: `Answer ${citationFence}` },
            {
                type: "tool-ask_clarifying_questions",
                toolCallId: "tool-1",
                state: "output-available",
                input: { questions: ["Which region?"] },
                output: { answers: ["EMEA"] },
                providerExecuted: false,
            },
        ]);

        expect(uiMessageToMessageParts(uiMessage)).toEqual([
            { type: "text", text: `Answer ${citationFence}` },
            {
                type: "tool",
                toolCallId: "tool-1",
                toolName: "ask_clarifying_questions",
                execution: "client",
                status: "completed",
                args: { questions: ["Which region?"] },
                result: { answers: ["EMEA"] },
            },
            {
                type: "metadata",
                metadata: {
                    modelId: "gpt-test",
                    totalTokens: 42,
                    durationMs: 900,
                },
            },
        ]);
    });

    test("maps db message metrics into UI metadata", () => {
        expect(
            toUIMessage({
                id: "msg-2",
                chatId: "chat-1",
                status: "completed",
                role: "assistant",
                parts: [{ type: "text", text: "Answer" }],
                tokensPerSecond: 12.5,
                timeToFirstToken: 220,
                inputTokens: 10,
                outputTokens: 20,
                totalTokens: 30,
                createdAt: new Date("2026-01-02T00:00:00.000Z"),
                updatedAt: new Date("2026-01-02T00:00:01.000Z"),
            })
        ).toEqual({
            id: "msg-2",
            role: "assistant",
            metadata: {
                createdAt: "2026-01-02T00:00:00.000Z",
                tokensPerSecond: 12.5,
                timeToFirstToken: 220,
                inputTokens: 10,
                outputTokens: 20,
                totalTokens: 30,
            },
            parts: [{ type: "text", text: "Answer" }],
        });
    });

    test("rebuilds model tool messages from assistant tool parts", () => {
        expect(
            toModelMessage({
                id: "msg-3",
                chatId: "chat-1",
                status: "completed",
                role: "assistant",
                parts: [
                    { type: "text", text: "Checking" },
                    {
                        type: "text",
                        text: stringifyCitationFence({
                            type: "cite",
                            sourceId: "src-1",
                            unitId: "unit-1",
                            fileName: "document.pdf",
                            fileKey: "graphs/g1/document.pdf",
                        }),
                    },
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
                tokensPerSecond: null,
                timeToFirstToken: null,
                inputTokens: null,
                outputTokens: null,
                totalTokens: null,
                createdAt: new Date("2026-01-03T00:00:00.000Z"),
                updatedAt: new Date("2026-01-03T00:00:01.000Z"),
            })
        ).toEqual([
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Checking" },
                    { type: "text", text: ':::{"type":"cite","id":"src-1"}:::' },
                    {
                        type: "tool-call",
                        toolCallId: "tool-1",
                        toolName: "ask_clarifying_questions",
                        input: { questions: ["Which region?"] },
                    },
                ],
            },
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "tool-1",
                        toolName: "ask_clarifying_questions",
                        output: { type: "json", value: { answers: ["EMEA"] } },
                    },
                ],
            },
        ]);
    });

    test("keeps compaction parts server-only in UI and model conversions", () => {
        const uiMessage = messagePartsToUIMessage(
            {
                id: "msg-4",
                role: "system",
                createdAt: new Date("2026-01-04T00:00:00.000Z"),
                parts: [
                    {
                        type: "compaction",
                        version: 1,
                        summary: "Summarized history",
                        summarizedThroughMessageId: "msg-2",
                    },
                ],
            },
            { modelId: "gpt-test" }
        );

        expect(uiMessage.parts).toEqual([]);
        expect(
            toModelMessage({
                id: "msg-4",
                chatId: "chat-1",
                status: "completed",
                role: "system",
                parts: [
                    {
                        type: "compaction",
                        version: 1,
                        summary: "Summarized history",
                        summarizedThroughMessageId: "msg-2",
                    },
                ],
                tokensPerSecond: null,
                timeToFirstToken: null,
                inputTokens: null,
                outputTokens: null,
                totalTokens: null,
                createdAt: new Date("2026-01-04T00:00:00.000Z"),
                updatedAt: new Date("2026-01-04T00:00:01.000Z"),
            })
        ).toEqual([]);
    });

    test("builds a validation toolset and exports validation schemas", () => {
        const toolset = buildChatValidationToolset({
            graphId: "graph-1",
            embeddingModel: {} as never,
            model: {} as never,
        });

        expect(Object.keys(toolset)).toContain("ask_clarifying_questions");
        expect(Object.keys(toolset)).toContain("explore_graph_with_subagent");
        expect(Object.keys(toolset)).toContain("correction");
        expect(chatMessageMetadataSchema.parse({ totalTokens: 12 })).toEqual({ totalTokens: 12 });
        expect(chatDataPartSchemas.step.parse({ name: "thinking" })).toEqual({ name: "thinking" });
    });

    test("validation toolset accepts persisted correction outputs", async () => {
        const toolset = buildChatValidationToolset({
            graphId: "graph-1",
            embeddingModel: {} as never,
            model: {} as never,
        });
        const message = toUIMessage({
            id: "msg-correction",
            chatId: "chat-1",
            status: "completed",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    toolCallId: "tool-1",
                    toolName: "correction",
                    execution: "server",
                    status: "completed",
                    args: {
                        kind: "source_correction",
                        sourceId: "source-1",
                        reference: "The answer said the deadline is Monday.",
                        suggestion: "The deadline is Tuesday.",
                    },
                    result: "## Correction suggestion\n- stored: suggestion-1\n- status: pending\n- nothing was applied yet",
                },
            ],
            tokensPerSecond: null,
            timeToFirstToken: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            createdAt: new Date("2026-01-06T00:00:00.000Z"),
            updatedAt: new Date("2026-01-06T00:00:01.000Z"),
        });

        await expect(
            validateUIMessages({
                messages: [message],
                tools: toolset,
                metadataSchema: chatMessageMetadataSchema,
                dataSchemas: chatDataPartSchemas,
            })
        ).resolves.toHaveLength(1);
    });

    test("validation toolset accepts legacy clarification outputs", async () => {
        const toolset = buildChatValidationToolset({
            graphId: "graph-1",
            embeddingModel: {} as never,
            model: {} as never,
        });
        const legacyResults = [{ questions: ["Which region?"] }, {}, null, "EMEA", ["EMEA"]];

        await Promise.all(
            legacyResults.map(async (result, index) => {
                const message = toUIMessage({
                    id: `msg-legacy-clarification-${index + 1}`,
                    chatId: "chat-1",
                    status: "completed",
                    role: "assistant",
                    parts: [
                        {
                            type: "tool",
                            toolCallId: "tool-1",
                            toolName: "ask_clarifying_questions",
                            execution: "client",
                            status: "completed",
                            args: { questions: ["Which region?"] },
                            result,
                        },
                    ],
                    tokensPerSecond: null,
                    timeToFirstToken: null,
                    inputTokens: null,
                    outputTokens: null,
                    totalTokens: null,
                    createdAt: new Date("2026-01-05T00:00:00.000Z"),
                    updatedAt: new Date("2026-01-05T00:00:01.000Z"),
                });

                await expect(
                    validateUIMessages({
                        messages: [message],
                        tools: toolset,
                        metadataSchema: chatMessageMetadataSchema,
                        dataSchemas: chatDataPartSchemas,
                    })
                ).resolves.toHaveLength(1);
            })
        );
    });
});
