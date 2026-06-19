import { searchWorkspace as searchWorkspaceData } from "../../lib/search";
import type { AuthUser } from "../../middleware/auth";
import { mapSearchFailure } from "./errors";

export function searchWorkspace(input: { user: AuthUser; query: string | undefined }) {
    return mapSearchFailure(searchWorkspaceData(input.user, input.query ?? ""));
}
