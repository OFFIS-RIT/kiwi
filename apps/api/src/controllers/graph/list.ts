import * as Effect from "effect/Effect";
import { listAccessibleGraphs } from "../../lib/graph/list";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";

export function listGraphs(input: { user: AuthUser }) {
    return tryApiPromise(async () => Effect.runPromise(listAccessibleGraphs(input.user)));
}
