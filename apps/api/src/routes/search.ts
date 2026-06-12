import { Result } from "better-result";
import { Elysia, t } from "elysia";
import { searchWorkspace } from "../lib/search";
import { authMiddleware } from "../middleware/auth";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

export const searchRoute = new Elysia({ prefix: "/search" }).use(authMiddleware).get(
    "/",
    async ({ query, user, status }) => {
        if (!user) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        const searchResult = await Result.tryPromise(async () => searchWorkspace(user, query.q ?? ""));

        if (searchResult.isErr()) {
            if (searchResult.error instanceof Error && searchResult.error.message === API_ERROR_CODES.FORBIDDEN) {
                return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
            }

            return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
        }

        return status(200, successResponse(searchResult.value));
    },
    {
        query: t.Object({
            q: t.Optional(t.String()),
        }),
    }
);
