import { describe, expect, mock, test } from "bun:test";
import { simulateReadableStream } from "ai";

mock.module("@kiwi/db", () => ({
    db: {},
}));

const {
    createCitationFenceStreamParser,
    messagePartsToUIMessage,
    parseCitationFence,
    splitTextWithCitationFences,
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
        expect(parseCitationFence(":::{ type: 'cite', id: 'src_1' }:::")).toEqual({ type: "cite", id: "src_1" });
    });

    test("splits complete text into text and citation segments", () => {
        expect(mergeTextSegments(splitTextWithCitationFences("Alpha :::{type:'cite',id:'src_1'}::: Omega"))).toEqual([
            { type: "text", text: "Alpha " },
            {
                type: "citation",
                citation: { type: "cite", id: "src_1" },
                raw: ":::{type:'cite',id:'src_1'}:::",
            },
            { type: "text", text: " Omega" },
        ]);
    });

    test("keeps invalid fences as plain text", () => {
        expect(
            mergeTextSegments(splitTextWithCitationFences("Alpha :::{ type: 'note', id: 'src_1' }::: Omega"))
        ).toEqual([{ type: "text", text: "Alpha :::{ type: 'note', id: 'src_1' }::: Omega" }]);
    });

    test("flushes unfinished fences as plain text", () => {
        const parser = createCitationFenceStreamParser();

        expect(parser.push("Alpha :::{ type: 'cite'")).toEqual([{ type: "text", text: "Alpha " }]);
        expect(parser.flush()).toEqual([{ type: "text", text: ":::{ type: 'cite'" }]);
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
                citation: { type: "cite", id: "src_1" },
                raw: ":::{ type: 'cite', id: 'src_1' }:::",
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
                citation: { type: "cite", id: "src_1" },
                raw: ":::{ type: 'cite', id: 'src_1' }:::",
            },
            {
                type: "citation",
                citation: { type: "cite", id: "src_2" },
                raw: ":::{ type: 'cite', id: 'src_2' }:::",
            },
        ]);
    });

    test("round-trips citation and tool parts between DB and UI messages", () => {
        const uiMessage = messagePartsToUIMessage(
            {
                id: "msg-1",
                role: "assistant",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                parts: [
                    { type: "text", text: "Answer " },
                    {
                        type: "citation",
                        citation: {
                            id: "src-1",
                            sourceId: "src-1",
                            textUnitId: "unit-1",
                            fileId: "file-1",
                            fileName: "document.pdf",
                            fileKey: "graphs/g1/document.pdf",
                            excerpt: "Evidence excerpt",
                        },
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
            { type: "text", text: "Answer " },
            {
                type: "data-citation",
                id: "src-1",
                data: {
                    id: "src-1",
                    sourceId: "src-1",
                    textUnitId: "unit-1",
                    fileId: "file-1",
                    fileName: "document.pdf",
                    fileKey: "graphs/g1/document.pdf",
                    excerpt: "Evidence excerpt",
                },
            },
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
            { type: "text", text: "Answer " },
            {
                type: "citation",
                citation: {
                    id: "src-1",
                    sourceId: "src-1",
                    textUnitId: "unit-1",
                    fileId: "file-1",
                    fileName: "document.pdf",
                    fileKey: "graphs/g1/document.pdf",
                    excerpt: "Evidence excerpt",
                },
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
            {
                type: "metadata",
                metadata: {
                    createdAt: "2026-01-01T00:00:00.000Z",
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
});
