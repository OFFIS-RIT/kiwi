import { describe, expect, test } from "vitest";
import { mergeUniqueProjectChats, sortProjectChats, upsertProjectChatSummary } from "./chat-summaries";

describe("chat summaries", () => {
    test("keeps pinned chats ahead of newer unpinned chats", () => {
        expect(
            sortProjectChats([
                { id: "chat-2", title: "Second", isPinned: false, updatedAt: "2026-05-28T10:00:00.000Z" },
                { id: "chat-1", title: "First", isPinned: true, updatedAt: "2026-05-27T10:00:00.000Z" },
            ]).map((chat) => chat.id)
        ).toEqual(["chat-1", "chat-2"]);
    });

    test("upserts chats without breaking pinned ordering", () => {
        expect(
            upsertProjectChatSummary(
                [
                    { id: "chat-1", title: "Pinned", isPinned: true, updatedAt: "2026-05-28T08:00:00.000Z" },
                    { id: "chat-2", title: "Existing", isPinned: false, updatedAt: "2026-05-28T07:00:00.000Z" },
                ],
                { id: "chat-2", title: "Existing", isPinned: false, updatedAt: "2026-05-28T09:00:00.000Z" }
            ).map((chat) => chat.id)
        ).toEqual(["chat-1", "chat-2"]);
    });

    test("merges chat pages without duplicating chats", () => {
        expect(
            mergeUniqueProjectChats(
                [
                    { id: "chat-1", title: "Pinned", isPinned: true, updatedAt: "2026-05-28T08:00:00.000Z" },
                    { id: "chat-2", title: "Existing", isPinned: false, updatedAt: "2026-05-28T07:00:00.000Z" },
                ],
                [
                    { id: "chat-2", title: "Existing", isPinned: false, updatedAt: "2026-05-28T07:00:00.000Z" },
                    { id: "chat-3", title: "Older", isPinned: false, updatedAt: "2026-05-28T06:00:00.000Z" },
                ]
            ).map((chat) => chat.id)
        ).toEqual(["chat-1", "chat-2", "chat-3"]);
    });
});
