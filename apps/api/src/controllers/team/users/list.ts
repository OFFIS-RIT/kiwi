import type { TeamUserListItem } from "@kiwi/contracts/teams";
import * as Effect from "effect/Effect";
import { requireTeamAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";
import { selectTeamUsers } from "./helpers";

export function listTeamUsers(input: { user: AuthUser; teamId: string }) {
    return tryApiPromise(async (): Promise<TeamUserListItem[]> => {
        await requireTeamAccess(input.user, input.teamId);
        return Effect.runPromise(selectTeamUsers(input.teamId));
    });
}
