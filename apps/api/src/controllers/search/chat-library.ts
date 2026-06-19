import { listArchivedChats as listArchivedChatsData, listPinnedChats as listPinnedChatsData } from "../../lib/search";
import { parseListNumber } from "../../lib/parse-query-params";
import type { AuthUser } from "../../middleware/auth";
import { mapSearchFailure } from "./errors";

export function listPinnedChats(input: { user: AuthUser }) {
    return mapSearchFailure(listPinnedChatsData(input.user));
}

export function listArchivedChats(input: { user: AuthUser; query: { offset?: string; limit?: string } }) {
    return mapSearchFailure(
        listArchivedChatsData(input.user, {
            offset: parseListNumber(input.query.offset, { minimum: 0, maximum: 10_000 }),
            limit: parseListNumber(input.query.limit, { minimum: 1, maximum: 100 }),
        })
    );
}
