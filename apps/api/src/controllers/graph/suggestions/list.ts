import * as Effect from "effect/Effect";
import { listPendingGraphSuggestions } from "../../../lib/graph-suggestions";
import { assertCanManageGraphSuggestions } from "../../../lib/graph/access";
import type { AuthUser } from "../../../middleware/auth";
import { toGraphSuggestionApiError } from "./shared";

export function listGraphSuggestions(input: { user: AuthUser; graphId: string }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                yield* assertCanManageGraphSuggestions(input.user, input.graphId);
                return yield* listPendingGraphSuggestions(input.graphId);
            }),
            (defect) => Effect.fail(defect)
        ),
        toGraphSuggestionApiError
    );
}
