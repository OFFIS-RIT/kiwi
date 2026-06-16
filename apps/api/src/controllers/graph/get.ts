import { eq } from "drizzle-orm";
import { db } from "@kiwi/db";
import { teamTable } from "@kiwi/db/tables/auth";
import { filesTable } from "@kiwi/db/tables/graph";
import type { GraphDetailFileRecord, GraphDetailSuccessData } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { assertCanViewGraph, resolveGraphOwnerRoot } from "../../lib/graph/access";
import { selectGraphDetailFileFields, toGraphFileRecord, type GraphFileRow } from "../../lib/graph/route";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";

export function getGraph(input: { user: AuthUser; graphId: string }) {
    return tryApiPromise(async (): Promise<GraphDetailSuccessData> => {
        const graph = await assertCanViewGraph(input.user, input.graphId);
        const rootOwner = await resolveGraphOwnerRoot(graph.id);
        let teamId: string | null = null;
        let teamName: string | null = null;

        if (rootOwner.mode === "team") {
            const [team] = await db
                .select({
                    id: teamTable.id,
                    name: teamTable.name,
                })
                .from(teamTable)
                .where(eq(teamTable.id, rootOwner.teamId))
                .limit(1);

            if (!team) {
                throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
            }

            teamId = team.id;
            teamName = team.name;
        }

        const fileRows: GraphFileRow[] = await db
            .select(selectGraphDetailFileFields)
            .from(filesTable)
            .where(eq(filesTable.graphId, graph.id));
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
    });
}
