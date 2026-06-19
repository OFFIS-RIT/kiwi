import * as Effect from "effect/Effect";
import { applyGraphSuggestion } from "../../../lib/graph-suggestions";
import { assertCanManageGraphSuggestions } from "../../../lib/graph/access";
import type { AuthUser } from "../../../middleware/auth";
import { toGraphSuggestionApiError } from "./shared";

export function applyPendingGraphSuggestion(input: { user: AuthUser; graphId: string; suggestionId: string }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                yield* assertCanManageGraphSuggestions(input.user, input.graphId);
                return yield* applyGraphSuggestion(input.graphId, input.suggestionId, input.user);
            }),
            (defect) => Effect.fail(defect)
        ),
        toGraphSuggestionApiError
    );
}
