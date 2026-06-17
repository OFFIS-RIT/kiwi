import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { teamTable } from "@kiwi/db/tables/auth";
import { filesTable, graphTable } from "@kiwi/db/tables/graph";
import { deleteFile, listFiles } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { internalServerError, teamNotFoundError } from "@kiwi/contracts/errors";
import { and, eq, inArray } from "drizzle-orm";
import { env } from "../../env";
import { chunk } from "../../lib/array";
import { requireOrganizationAdmin } from "../../lib/team/access";
import { cancelActiveFileProcessingWorkflowRuns, cancelActiveGraphWorkflowRuns } from "../../lib/workflow-cancellation";
import type { AuthUser } from "../../middleware/auth";
import { toApiError } from "../_shared/api-effect";

type TeamDeleteScope = {
    graphIds: string[];
    fileRows: Array<{ id: string; graphId: string; key: string }>;
    organizationId: string;
};

function collectTeamGraphIds(rootGraphIds: string[]) {
    return Effect.gen(function* () {
        if (rootGraphIds.length === 0) {
            return [];
        }

        const graphIds = new Set(rootGraphIds);
        let frontier = [...graphIds];

        while (frontier.length > 0) {
            const childRows = yield* tryDb((db) =>
                db.select({ id: graphTable.id }).from(graphTable).where(inArray(graphTable.graphId, frontier))
            );

            const nextFrontier: string[] = [];
            for (const child of childRows) {
                if (graphIds.has(child.id)) {
                    continue;
                }

                graphIds.add(child.id);
                nextFrontier.push(child.id);
            }

            frontier = nextFrontier;
        }

        return [...graphIds];
    });
}

function getTeamDeleteScope(user: AuthUser, teamId: string) {
    return Effect.gen(function* () {
        const membership = yield* requireOrganizationAdmin(user);
        const organizationId = membership.organizationId;

        const [team] = yield* tryDb((db) =>
            db
                .select({ id: teamTable.id })
                .from(teamTable)
                .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, organizationId)))
                .limit(1)
        );

        if (!team) {
            return yield* Effect.fail(teamNotFoundError());
        }

        const directGraphRows = yield* tryDb((db) =>
            db.select({ id: graphTable.id }).from(graphTable).where(eq(graphTable.teamId, teamId))
        );
        const graphIds = yield* collectTeamGraphIds(directGraphRows.map((graph) => graph.id));
        const fileRows =
            graphIds.length > 0
                ? yield* tryDb((db) =>
                      db
                          .select({
                              id: filesTable.id,
                              graphId: filesTable.graphId,
                              key: filesTable.key,
                          })
                          .from(filesTable)
                          .where(inArray(filesTable.graphId, graphIds))
                  )
                : [];

        return {
            graphIds,
            fileRows,
            organizationId,
        };
    });
}

function cancelTeamGraphWorkflows(teamId: string, scope: TeamDeleteScope): Effect.Effect<void, unknown, Database> {
    const fileIdsByGraphId = new Map<string, string[]>();
    for (const file of scope.fileRows) {
        const fileIds = fileIdsByGraphId.get(file.graphId) ?? [];
        fileIds.push(file.id);
        fileIdsByGraphId.set(file.graphId, fileIds);
    }

    return Effect.matchEffect(
        Effect.asVoid(
            Effect.all(
                [
                    cancelActiveGraphWorkflowRuns(scope.graphIds),
                    ...[...fileIdsByGraphId].map(([graphId, fileIds]) =>
                        cancelActiveFileProcessingWorkflowRuns(graphId, fileIds)
                    ),
                ],
                { concurrency: "unbounded" }
            )
        ),
        {
            onFailure: (error) => {
                logError("team workflow cancellation failed before team delete", {
                    teamId,
                    graphCount: scope.graphIds.length,
                    fileCount: scope.fileRows.length,
                    error,
                });

                return Effect.fail(internalServerError());
            },
            onSuccess: () => Effect.void,
        }
    );
}

function deleteTeamRow(teamId: string, scope: TeamDeleteScope) {
    return tryDb((db) =>
        db.transaction((tx) =>
            Effect.gen(function* () {
                const [team] = yield* tx
                    .select({ id: teamTable.id })
                    .from(teamTable)
                    .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, scope.organizationId)))
                    .limit(1);

                if (!team) {
                    return yield* Effect.fail(teamNotFoundError());
                }

                yield* tx.delete(teamTable).where(eq(teamTable.id, teamId));

                return {
                    teamId,
                    graphIds: scope.graphIds,
                    fileRows: scope.fileRows,
                };
            })
        )
    );
}

function cleanupTeamS3Objects(input: {
    teamId: string;
    graphIds: string[];
    fileRows: Array<{ key: string }>;
}): Effect.Effect<{ attemptedKeyCount: number; failedKeyCount: number }, unknown> {
    return Effect.gen(function* () {
        const trackedKeys = input.fileRows.map((file) => file.key);
        const listedKeyResults = yield* Effect.all(
            input.graphIds.map((graphId) =>
                Effect.match(listFiles(`graphs/${graphId}/`, env.S3_BUCKET), {
                    onFailure: (reason) => ({ status: "rejected" as const, reason }),
                    onSuccess: (value) => ({ status: "fulfilled" as const, value }),
                })
            ),
            { concurrency: "unbounded" }
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
            const results = yield* Effect.all(
                keys.map((key) =>
                    Effect.match(deleteFile(key, env.S3_BUCKET), {
                        onFailure: (reason) => ({ status: "rejected" as const, reason }),
                        onSuccess: () => ({ status: "fulfilled" as const }),
                    })
                ),
                { concurrency: "unbounded" }
            );

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
    });
}

export function deleteTeam(input: { user: AuthUser; teamId: string }) {
    return Effect.mapError(
        Effect.gen(function* () {
            const scope = yield* getTeamDeleteScope(input.user, input.teamId);
            yield* cancelTeamGraphWorkflows(input.teamId, scope);
            const deletedTeam = yield* deleteTeamRow(input.teamId, scope);
            const s3Cleanup = yield* cleanupTeamS3Objects({
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
        }),
        toApiError
    );
}
