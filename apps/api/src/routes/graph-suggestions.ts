import { runDatabaseEffect } from "@kiwi/db/effect";
import * as Effect from "effect/Effect";
import { Elysia, t } from "elysia";
import { assertCanManageGraphSuggestions } from "../lib/graph/access";
import {
    applyGraphSuggestion,
    deletePendingGraphSuggestion,
    listPendingGraphSuggestions,
} from "../lib/graph-suggestions";
import { mapGraphError } from "../lib/graph/route";
import { authMiddleware } from "../middleware/auth";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

type SuggestionRouteStatus = (code: number, body: unknown) => unknown;

function mapSuggestionError(status: SuggestionRouteStatus, error: unknown) {
    if (error instanceof Error && error.message === API_ERROR_CODES.SUGGESTION_NOT_FOUND) {
        return status(404, errorResponse("Suggestion not found", API_ERROR_CODES.SUGGESTION_NOT_FOUND));
    }

    if (error instanceof Error && error.message === API_ERROR_CODES.INVALID_SUGGESTION) {
        return status(400, errorResponse("Invalid suggestion", API_ERROR_CODES.INVALID_SUGGESTION));
    }

    if (error instanceof Error && error.message === API_ERROR_CODES.SOURCE_NOT_FOUND) {
        return status(404, errorResponse("Source not found", API_ERROR_CODES.SOURCE_NOT_FOUND));
    }

    return mapGraphError(status, error);
}

export const graphSuggestionsRoute = new Elysia({ prefix: "/graphs" })
    .use(authMiddleware)
    .get(
        "/:id/suggestions",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            try {
                const suggestions = await runDatabaseEffect(
                    Effect.gen(function* () {
                        yield* assertCanManageGraphSuggestions(user, params.id);
                        return yield* listPendingGraphSuggestions(params.id);
                    })
                );
                return status(200, successResponse(suggestions));
            } catch (error) {
                return mapSuggestionError(status, error);
            }
        },
        {
            params: t.Object({
                id: t.String(),
            }),
        }
    )
    .delete(
        "/:id/suggestions/:suggestionId",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            try {
                await runDatabaseEffect(
                    Effect.gen(function* () {
                        yield* assertCanManageGraphSuggestions(user, params.id);
                        yield* deletePendingGraphSuggestion(params.id, params.suggestionId);
                    })
                );
                return status(204, null);
            } catch (error) {
                return mapSuggestionError(status, error);
            }
        },
        {
            params: t.Object({
                id: t.String(),
                suggestionId: t.String(),
            }),
        }
    )
    .post(
        "/:id/suggestions/:suggestionId/apply",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            try {
                const result = await runDatabaseEffect(
                    Effect.gen(function* () {
                        yield* assertCanManageGraphSuggestions(user, params.id);
                        return yield* applyGraphSuggestion(params.id, params.suggestionId, user);
                    })
                );
                return status(200, successResponse(result));
            } catch (error) {
                return mapSuggestionError(status, error);
            }
        },
        {
            params: t.Object({
                id: t.String(),
                suggestionId: t.String(),
            }),
        }
    );
