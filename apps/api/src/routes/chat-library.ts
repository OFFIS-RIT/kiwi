import { runDatabaseEffect } from "@kiwi/db/effect";
import { Elysia, t } from "elysia";
import { parseListNumber } from "../lib/parse-query-params";
import { listArchivedChats, listPinnedChats } from "../lib/search";
import { authMiddleware } from "../middleware/auth";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

function mapLibraryError(status: (code: number, body: unknown) => unknown, error: unknown) {
    if (error instanceof Error && error.message === API_ERROR_CODES.FORBIDDEN) {
        return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
    }

    return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
}

export const chatLibraryRoute = new Elysia({ prefix: "/chats" })
    .use(authMiddleware)
    .get("/pinned", async ({ user, status }) => {
        if (!user) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        try {
            const result = await runDatabaseEffect(listPinnedChats(user));
            return status(200, successResponse(result));
        } catch (error) {
            return mapLibraryError(status, error);
        }
    })
    .get(
        "/archived",
        async ({ query, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            try {
                const result = await runDatabaseEffect(
                    listArchivedChats(user, {
                        offset: parseListNumber(query.offset, { minimum: 0, maximum: 10_000 }),
                        limit: parseListNumber(query.limit, { minimum: 1, maximum: 100 }),
                    })
                );
                return status(200, successResponse(result));
            } catch (error) {
                return mapLibraryError(status, error);
            }
        },
        {
            query: t.Object({
                offset: t.Optional(t.String()),
                limit: t.Optional(t.String()),
            }),
        }
    );
