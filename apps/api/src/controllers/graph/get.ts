import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { teamTable } from "@kiwi/db/tables/auth";
import { filesTable } from "@kiwi/db/tables/graph";
import type { GraphDetailFileRecord } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { assertCanViewGraph, resolveGraphOwnerRoot } from "../../lib/graph/access";
import { selectGraphDetailFileFields, toGraphFileRecord, type GraphFileRow } from "../../lib/graph/route";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";

export function getGraph(input: { user: AuthUser; graphId: string }) {
    return Effect.mapError(Effect.catchDefect(Effect.gen(function* () {
        const graph = yield* assertCanViewGraph(input.user, input.graphId);
        const rootOwner = yield* resolveGraphOwnerRoot(graph.id);
        let teamId: string | null = null;
        let teamName: string | null = null;

        if (rootOwner.mode === "team") {
            const [team] = yield* tryDb((db) =>
                db
                    .select({
                        id: teamTable.id,
                        name: teamTable.name,
                    })
                    .from(teamTable)
                    .where(eq(teamTable.id, rootOwner.teamId))
                    .limit(1)
            );

            if (!team) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.TEAM_NOT_FOUND));
            }

            teamId = team.id;
            teamName = team.name;
        }

        const fileRows: GraphFileRow[] = yield* tryDb((db) =>
            db.select(selectGraphDetailFileFields).from(filesTable).where(eq(filesTable.graphId, graph.id))
        );
        const files: GraphDetailFileRecord[] = fileRows.map(toGraphFileRecord);

        return {
            project_id: graph.id,
            project_name: graph.name,
            project_state: graph.state === "updating" ? "update" : "ready",
            description: graph.description,
            hidden: graph.hidden,
            organization_id: graph.organizationId,
            team_id: teamId,
            team_name: teamName,
            scope: rootOwner.mode === "user" ? "private" : rootOwner.mode === "team" ? "team" : "organization",
            files,
        };
    }), (defect) => Effect.fail(defect)), toApiError);
}
