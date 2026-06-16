import { listAccessibleGraphs } from "../../lib/graph/list";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";

export function listGraphs(input: { user: AuthUser }) {
    return tryApiPromise(async () => listAccessibleGraphs(input.user));
}
