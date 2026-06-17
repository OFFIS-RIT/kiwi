import * as Effect from "effect/Effect";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadSourceReference } from "../../../lib/source-reference";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";

export function getSourceReference(input: { user: AuthUser; graphId: string; sourceId: string }) {
    return Effect.mapError(Effect.catchDefect(Effect.gen(function* () {
        yield* assertCanViewGraph(input.user, input.graphId);
        return yield* loadSourceReference(input.graphId, input.sourceId);
    }), (defect) => Effect.fail(defect)), toApiError);
}
