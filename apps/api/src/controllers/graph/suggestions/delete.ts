import * as Effect from "effect/Effect";
import { deletePendingGraphSuggestion } from "../../../lib/graph-suggestions";
import { assertCanManageGraphSuggestions } from "../../../lib/graph/access";
import type { AuthUser } from "../../../middleware/auth";
import { toGraphSuggestionApiError } from "./shared";

export function deleteGraphSuggestion(input: { user: AuthUser; graphId: string; suggestionId: string }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                yield* assertCanManageGraphSuggestions(input.user, input.graphId);
                yield* deletePendingGraphSuggestion(input.graphId, input.suggestionId);
            }),
            (defect) => Effect.fail(defect)
        ),
        toGraphSuggestionApiError
    );
}
