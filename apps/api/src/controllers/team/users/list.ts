import * as Effect from "effect/Effect";
import { requireTeamAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";
import { selectTeamUsers } from "./helpers";

export function listTeamUsers(input: { user: AuthUser; teamId: string }) {
    return Effect.mapError(
        Effect.gen(function* () {
            yield* requireTeamAccess(input.user, input.teamId);
            return yield* selectTeamUsers(input.teamId);
        }),
        toApiError
    );
}
