import { Elysia, t } from "elysia";
import { runApiAction } from "../controllers/_shared/api-effect";
import { searchWorkspace } from "../controllers/search/search-workspace";
import { authMiddleware } from "../middleware/auth";
import { successResponse } from "../types";

export const searchRoute = new Elysia({ prefix: "/search" }).use(authMiddleware).get(
    "/",
    ({ query, user, status }) =>
        runApiAction({
            status,
            user,
            action: (currentUser) => searchWorkspace({ user: currentUser, query: query.q }),
            success: (value) => status(200, successResponse(value)),
        }),
    {
        query: t.Object({
            q: t.Optional(t.String()),
        }),
    }
);
