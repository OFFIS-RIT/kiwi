import * as Effect from "effect/Effect";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadSourceReferences } from "../../../lib/source-reference";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";

export function listSourceReferences(input: { user: AuthUser; graphId: string; sourceIds: string[] }) {
    return Effect.mapError(Effect.catchDefect(Effect.gen(function* () {
        yield* assertCanViewGraph(input.user, input.graphId);
        return yield* loadSourceReferences(input.graphId, input.sourceIds);
    }), (defect) => Effect.fail(defect)), toApiError);
}
