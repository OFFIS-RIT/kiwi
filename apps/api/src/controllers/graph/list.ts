import { listAccessibleGraphs } from "../../lib/graph/list";
import type { AuthUser } from "../../middleware/auth";

export function listGraphs(input: { user: AuthUser }) {
    return listAccessibleGraphs(input.user);
}
