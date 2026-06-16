import { db } from "@kiwi/db";
import * as Effect from "effect/Effect";
import { teamTable } from "@kiwi/db/tables/auth";
import { filesTable, graphTable } from "@kiwi/db/tables/graph";
import { deleteFile, listFiles } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import type { TeamDeleteSuccessData } from "@kiwi/contracts/teams";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { and, eq, inArray } from "drizzle-orm";
import { env } from "../../env";
import { chunk } from "../../lib/array";
import { collectGraphClosure } from "../../lib/graph";
import { requireOrganizationAdmin } from "../../lib/team/access";
import { cancelActiveFileProcessingWorkflowRuns, cancelActiveGraphWorkflowRuns } from "../../lib/workflow-cancellation";
import type { AuthUser } from "../../middleware/auth";
import { tryApiPromise } from "../_shared/api-effect";

type TeamDeleteScope = {
    graphIds: string[];
    fileRows: Array<{ id: string; graphId: string; key: string }>;
    organizationId: string;
};

async function getTeamDeleteScope(user: AuthUser, teamId: string): Promise<TeamDeleteScope> {
    const membership = await requireOrganizationAdmin(user);
    const organizationId = membership.organizationId;

    const [team] = await db
        .select({ id: teamTable.id })
        .from(teamTable)
        .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, organizationId)))
        .limit(1);

    if (!team) {
        throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
    }

    const directGraphRows = await db.select({ id: graphTable.id }).from(graphTable).where(eq(graphTable.teamId, teamId));

    const graphIds = await collectGraphClosure(
        db,
        directGraphRows.map((graph) => graph.id)
    );
    const fileRows =
        graphIds.length > 0
            ? await db
                  .select({
                      id: filesTable.id,
                      graphId: filesTable.graphId,
                      key: filesTable.key,
                  })
                  .from(filesTable)
                  .where(inArray(filesTable.graphId, graphIds))
            : [];

    return {
        graphIds,
        fileRows,
        organizationId,
    };
}

async function cancelTeamGraphWorkflows(teamId: string, scope: TeamDeleteScope) {
    const fileIdsByGraphId = new Map<string, string[]>();
    for (const file of scope.fileRows) {
        const fileIds = fileIdsByGraphId.get(file.graphId) ?? [];
        fileIds.push(file.id);
        fileIdsByGraphId.set(file.graphId, fileIds);
    }

    try {
        await Promise.all([
            cancelActiveGraphWorkflowRuns(scope.graphIds),
            ...[...fileIdsByGraphId].map(([graphId, fileIds]) => cancelActiveFileProcessingWorkflowRuns(graphId, fileIds)),
        ]);
    } catch (error) {
        logError("team workflow cancellation failed before team delete", {
            teamId,
            graphCount: scope.graphIds.length,
            fileCount: scope.fileRows.length,
            error,
        });

        throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
    }
}

async function deleteTeamRow(teamId: string, scope: TeamDeleteScope) {
    return db.transaction(async (tx) => {
        const [team] = await tx
            .select({ id: teamTable.id })
            .from(teamTable)
            .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, scope.organizationId)))
            .limit(1);

        if (!team) {
            throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
        }

        await tx.delete(teamTable).where(eq(teamTable.id, teamId));

        return {
            teamId,
            graphIds: scope.graphIds,
            fileRows: scope.fileRows,
        };
    });
}

async function cleanupTeamS3Objects(input: {
    teamId: string;
    graphIds: string[];
    fileRows: Array<{ key: string }>;
}) {
    const trackedKeys = input.fileRows.map((file) => file.key);
    const listedKeyResults = await Promise.allSettled(
        input.graphIds.map((graphId) => Effect.runPromise(listFiles(`graphs/${graphId}/`, env.S3_BUCKET)))
    );

    const s3Keys = new Set(trackedKeys);
    let listFailureCount = 0;

    for (const result of listedKeyResults) {
        if (result.status === "fulfilled") {
            for (const key of result.value) {
                s3Keys.add(key);
            }
            continue;
        }

        listFailureCount += 1;
    }

    let deleteFailureCount = 0;
    for (const keys of chunk([...s3Keys], 25)) {
        const results = await Promise.allSettled(keys.map((key) => Effect.runPromise(deleteFile(key, env.S3_BUCKET))));

        for (const result of results) {
            if (result.status === "rejected") {
                deleteFailureCount += 1;
            }
        }
    }

    const failedKeyCount = listFailureCount + deleteFailureCount;
    if (failedKeyCount > 0) {
        logError("Team deleted with incomplete S3 cleanup", {
            teamId: input.teamId,
            graphCount: input.graphIds.length,
            attemptedKeyCount: s3Keys.size,
            failedKeyCount,
        });
    }

    return {
        attemptedKeyCount: s3Keys.size,
        failedKeyCount,
    };
}

export function deleteTeam(input: { user: AuthUser; teamId: string }) {
    return tryApiPromise(async (): Promise<TeamDeleteSuccessData> => {
        const scope = await getTeamDeleteScope(input.user, input.teamId);
        await cancelTeamGraphWorkflows(input.teamId, scope);
        const deletedTeam = await deleteTeamRow(input.teamId, scope);
        const s3Cleanup = await cleanupTeamS3Objects({
            teamId: deletedTeam.teamId,
            graphIds: deletedTeam.graphIds,
            fileRows: deletedTeam.fileRows,
        });

        return {
            teamId: deletedTeam.teamId,
            deletedGraphCount: deletedTeam.graphIds.length,
            deletedFileCount: deletedTeam.fileRows.length,
            s3Cleanup,
            ...(s3Cleanup.failedKeyCount > 0
                ? {
                      warnings: ["Some S3 objects could not be deleted after the team was removed"],
                  }
                : {}),
        };
    });
}
