import { describe, expect, it } from "vitest";

import { prepareLatestMessageRequest } from "./ChatSessionsProvider";

describe("prepareLatestMessageRequest", () => {
    it("sends only the latest message and preserves extra body fields", () => {
        const firstMessage = {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
        };
        const latestMessage = {
            id: "msg-2",
            role: "assistant",
            parts: [{ type: "text", text: "world" }],
        };

        expect(
            prepareLatestMessageRequest({
                id: "chat-1",
                messages: [firstMessage, latestMessage],
                body: { deep: true },
            })
        ).toEqual({
            body: {
                id: "chat-1",
                message: latestMessage,
                deep: true,
            },
        });
    });
});
