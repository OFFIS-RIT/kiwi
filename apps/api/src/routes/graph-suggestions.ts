import { Result } from "better-result";
import { Elysia, t } from "elysia";
import { assertCanManageGraphSuggestions } from "../lib/graph-access";
import {
    applyGraphSuggestion,
    deletePendingGraphSuggestion,
    listPendingGraphSuggestions,
} from "../lib/graph-suggestions";
import { mapGraphError } from "../lib/graph-route";
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

            const suggestionsResult = await Result.tryPromise(async () => {
                await assertCanManageGraphSuggestions(user, params.id);
                return listPendingGraphSuggestions(params.id);
            });

            if (suggestionsResult.isErr()) {
                return mapSuggestionError(status, suggestionsResult.error);
            }

            return status(200, successResponse(suggestionsResult.value));
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

            const deleteResult = await Result.tryPromise(async () => {
                await assertCanManageGraphSuggestions(user, params.id);
                await deletePendingGraphSuggestion(params.id, params.suggestionId);
            });

            if (deleteResult.isErr()) {
                return mapSuggestionError(status, deleteResult.error);
            }

            return status(204, null);
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

            const applyResult = await Result.tryPromise(async () => {
                await assertCanManageGraphSuggestions(user, params.id);
                return applyGraphSuggestion(params.id, params.suggestionId, user);
            });

            if (applyResult.isErr()) {
                return mapSuggestionError(status, applyResult.error);
            }

            return status(200, successResponse(applyResult.value));
        },
        {
            params: t.Object({
                id: t.String(),
                suggestionId: t.String(),
            }),
        }
    );
