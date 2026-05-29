import type { ProjectChatSummary } from "@/types";

function getUpdatedAtValue(updatedAt: string | null | undefined) {
    if (!updatedAt) {
        return 0;
    }

    const value = new Date(updatedAt).getTime();
    return Number.isFinite(value) ? value : 0;
}

export function compareProjectChats(left: ProjectChatSummary, right: ProjectChatSummary) {
    if (left.isPinned !== right.isPinned) {
        return left.isPinned ? -1 : 1;
    }

    const updatedAtDiff = getUpdatedAtValue(right.updatedAt) - getUpdatedAtValue(left.updatedAt);
    if (updatedAtDiff !== 0) {
        return updatedAtDiff;
    }

    return right.id.localeCompare(left.id);
}

export function sortProjectChats<T extends ProjectChatSummary>(chats: T[]) {
    return [...chats].sort(compareProjectChats);
}

export function upsertProjectChatSummary<T extends ProjectChatSummary>(
    chats: T[] = [],
    chat: T,
    options: { limit?: number } = {}
) {
    const nextChats = sortProjectChats([chat, ...chats.filter((item) => item.id !== chat.id)]);
    return typeof options.limit === "number" ? nextChats.slice(0, options.limit) : nextChats;
}

export function mergeUniqueProjectChats<T extends ProjectChatSummary>(...lists: T[][]) {
    const seenIds = new Set<string>();
    const merged: T[] = [];

    for (const list of lists) {
        for (const chat of list) {
            if (seenIds.has(chat.id)) {
                continue;
            }

            seenIds.add(chat.id);
            merged.push(chat);
        }
    }

    return merged;
}
