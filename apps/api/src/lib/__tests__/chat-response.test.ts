import { describe, expect, mock, test } from "bun:test";
import type { StartedChatReply } from "../chat-response";

const dbMock = {};
const envMock = {
    AI_TEXT_MODEL: "gpt-test",
};

mock.module("@kiwi/db", () => ({
    betterAuthDb: dbMock,
    db: dbMock,
}));

mock.module("../../env", () => ({
    env: envMock,
}));

const { buildFinishMetadata } = await import("../chat-response");

function replyWithUsage(usage: ReturnType<NonNullable<StartedChatReply["getAdditionalUsage"]>>) {
    return {
        getAdditionalUsage: () => usage,
    } as StartedChatReply;
}

describe("chat response metadata", () => {
    test("counts all considered files separately from files used in the final answer", () => {
        const consideredFileIds = Array.from({ length: 10 }, (_, index) => `file-${index + 1}`);
        const citationFileIds = new Set(["file-1", "file-2"]);

        const metadata = buildFinishMetadata({
            reply: replyWithUsage({
                consideredFileIds,
                usedFileIds: ["file-3"],
            }),
            startedAt: Date.now() - 1000,
            firstOutputAt: Date.now() - 900,
            totalTokens: 30,
            inputTokens: 20,
            outputTokens: 10,
            modelId: "gpt-test",
            citationFileIds,
        });

        expect(metadata.consideredFileCount).toBe(10);
        expect(metadata.usedFileCount).toBe(3);
    });
});
