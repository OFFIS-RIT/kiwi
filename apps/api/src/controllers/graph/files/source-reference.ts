import * as Effect from "effect/Effect";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadSourceReference } from "../../../lib/source-reference";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function getSourceReference(input: { user: AuthUser; graphId: string; sourceId: string }) {
    return tryApiPromise(async () => {
        await Effect.runPromise(assertCanViewGraph(input.user, input.graphId));
        return Effect.runPromise(loadSourceReference(input.graphId, input.sourceId));
    });
}
