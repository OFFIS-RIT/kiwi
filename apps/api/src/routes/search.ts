import { runDatabaseEffect } from "@kiwi/db/effect";
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

        try {
            const result = await runDatabaseEffect(searchWorkspace(user, query.q ?? ""));
            return status(200, successResponse(result));
        } catch (error) {
            if (error instanceof Error && error.message === API_ERROR_CODES.FORBIDDEN) {
                return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
            }

            return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
        }
    },
    {
        query: t.Object({
            q: t.Optional(t.String()),
        }),
    }
);
