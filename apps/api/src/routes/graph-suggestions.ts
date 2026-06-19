import { successResponse } from "@kiwi/contracts/errors";
import { Elysia, t } from "elysia";
import { runApiAction } from "../controllers/_shared/api-effect";
import { applyPendingGraphSuggestion } from "../controllers/graph/suggestions/apply";
import { deleteGraphSuggestion } from "../controllers/graph/suggestions/delete";
import { listGraphSuggestions } from "../controllers/graph/suggestions/list";
import { authMiddleware } from "../middleware/auth";

export const graphSuggestionsRoute = new Elysia({ prefix: "/graphs" })
    .use(authMiddleware)
    .get(
        "/:id/suggestions",
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) => listGraphSuggestions({ user: currentUser, graphId: params.id }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
            }),
        }
    )
    .delete(
        "/:id/suggestions/:suggestionId",
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    deleteGraphSuggestion({
                        user: currentUser,
                        graphId: params.id,
                        suggestionId: params.suggestionId,
                    }),
                success: () => status(204, null),
            }),
        {
            params: t.Object({
                id: t.String(),
                suggestionId: t.String(),
            }),
        }
    )
    .post(
        "/:id/suggestions/:suggestionId/apply",
        ({ params, user, status }) =>
            runApiAction({
                status,
                user,
                action: (currentUser) =>
                    applyPendingGraphSuggestion({
                        user: currentUser,
                        graphId: params.id,
                        suggestionId: params.suggestionId,
                    }),
                success: (value) => status(200, successResponse(value)),
            }),
        {
            params: t.Object({
                id: t.String(),
                suggestionId: t.String(),
            }),
        }
    );
