import Elysia from "elysia";
import { roleIncludes } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import {
    memberTable,
    teamMemberRolesTable,
    teamMemberTable,
    teamTable,
    userTable,
    type TeamMemberRole,
} from "@kiwi/db/tables/auth";
import { filesTable, graphTable } from "@kiwi/db/tables/graph";
import { deleteFile, listFiles } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { Result } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import z from "zod";
import { env } from "../env";
import { chunk } from "../lib/array";
import { collectGraphClosure } from "../lib/graph";
import {
    requireOrganizationAdmin,
    requireOrganizationMembership,
    requireTeamAccess,
    requireTeamMemberManageAccess,
} from "../lib/team-access";
import { cancelActiveFileProcessingWorkflowRuns, cancelActiveGraphWorkflowRuns } from "../lib/workflow-cancellation";
import { authMiddleware } from "../middleware/auth";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

const teamUserRoleSchema = z.enum(["admin", "moderator", "member"]);

type TeamUserInput = {
    user_id: string;
    role: TeamMemberRole;
};

type RouteStatus = (code: number, body: unknown) => unknown;

function mapTeamError(status: RouteStatus, error: unknown) {
    if (!(error instanceof Error)) {
        return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }

    if (error.message === API_ERROR_CODES.TEAM_NOT_FOUND) {
        return status(404, errorResponse("Team not found", API_ERROR_CODES.TEAM_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.FORBIDDEN) {
        return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
    }

    if (error.message === API_ERROR_CODES.INVALID_TEAM_MEMBERS) {
        return status(
            400,
            errorResponse("A team must have at least one admin", API_ERROR_CODES.INVALID_TEAM_MEMBERS)
        );
    }

    return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
}

function normalizeUsers({
    users,
    overrides = [],
}: {
    users: TeamUserInput[] | undefined;
    overrides?: TeamUserInput[];
}) {
    const byUserId = new Map<string, TeamUserInput>();

    for (const user of users ?? []) {
        byUserId.set(user.user_id, user);
    }

    for (const user of overrides) {
        byUserId.set(user.user_id, user);
    }

    return [...byUserId.values()];
}

function ensureTeamHasAdmin(users: TeamUserInput[]) {
    if (!users.some((teamUser) => teamUser.role === "admin")) {
        throw new Error(API_ERROR_CODES.INVALID_TEAM_MEMBERS);
    }
}

async function ensureOrganizationMembers(organizationId: string, userIds: string[]) {
    if (userIds.length === 0) {
        return;
    }

    const rows = await db
        .select({ userId: memberTable.userId })
        .from(memberTable)
        .where(and(eq(memberTable.organizationId, organizationId), inArray(memberTable.userId, userIds)));
    const foundUserIds = new Set(rows.map((row) => row.userId));

    if (userIds.some((userId) => !foundUserIds.has(userId))) {
        throw new Error(API_ERROR_CODES.FORBIDDEN);
    }
}

async function listTeamUsers(teamId: string) {
    const role = sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`;

    const users = await db
        .select({
            team_id: teamMemberTable.teamId,
            user_id: teamMemberTable.userId,
            user_name: userTable.name,
            role,
            created_at: teamMemberTable.createdAt,
            updated_at: teamMemberRolesTable.updatedAt,
        })
        .from(teamMemberTable)
        .innerJoin(userTable, eq(userTable.id, teamMemberTable.userId))
        .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
        .where(eq(teamMemberTable.teamId, teamId))
        .orderBy(asc(userTable.name), asc(teamMemberTable.userId));

    return users.map((user) => ({
        team_id: user.team_id,
        user_id: user.user_id,
        user_name: user.user_name,
        role: user.role,
        created_at: user.created_at?.toISOString() ?? null,
        updated_at: user.updated_at?.toISOString() ?? null,
    }));
}

export const teamRoute = new Elysia({ prefix: "/teams" })
    .use(authMiddleware)
    .get("/", async ({ status, user }) => {
        if (!user) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        const teamsResult = await Result.tryPromise(async () => {
            const membership = await requireOrganizationMembership(user);
            const organizationId = membership.organizationId;

            if (roleIncludes(membership.role, "admin")) {
                const teams = await db
                    .select({
                        team_id: teamTable.id,
                        team_name: teamTable.name,
                    })
                    .from(teamTable)
                    .where(eq(teamTable.organizationId, organizationId))
                    .orderBy(asc(teamTable.name));

                return teams.map((team) => ({
                    ...team,
                    role: "admin" as const,
                }));
            }

            const role = sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`;

            return db
                .select({
                    team_id: teamTable.id,
                    team_name: teamTable.name,
                    role,
                })
                .from(teamMemberTable)
                .innerJoin(teamTable, eq(teamTable.id, teamMemberTable.teamId))
                .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                .where(and(eq(teamTable.organizationId, organizationId), eq(teamMemberTable.userId, user.id)))
                .orderBy(asc(teamTable.name));
        });

        if (teamsResult.isErr()) {
            return mapTeamError(status, teamsResult.error);
        }

        return status(200, successResponse(teamsResult.value));
    })
    .post(
        "/",
        async ({ status, body, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const createResult = await Result.tryPromise(async () => {
                const membership = await requireOrganizationAdmin(user);
                const organizationId = membership.organizationId;
                const normalizedUsers = normalizeUsers({
                    users: body.users,
                    overrides: [{ user_id: user.id, role: "admin" }],
                });
                ensureTeamHasAdmin(normalizedUsers);
                await ensureOrganizationMembers(
                    organizationId,
                    normalizedUsers.map((teamUser) => teamUser.user_id)
                );

                return db.transaction(async (tx) => {
                    const [team] = await tx
                        .insert(teamTable)
                        .values({
                            name: body.name,
                            organizationId,
                        })
                        .returning({ id: teamTable.id });

                    if (!team) {
                        throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
                    }

                    const roleByUserId = new Map(normalizedUsers.map((teamUser) => [teamUser.user_id, teamUser.role]));
                    const teamMembers =
                        normalizedUsers.length > 0
                            ? await tx
                                  .insert(teamMemberTable)
                                  .values(
                                      normalizedUsers.map((teamUser) => ({ teamId: team.id, userId: teamUser.user_id }))
                                  )
                                  .returning({
                                      id: teamMemberTable.id,
                                      teamId: teamMemberTable.teamId,
                                      userId: teamMemberTable.userId,
                                      createdAt: teamMemberTable.createdAt,
                                  })
                            : [];

                    if (teamMembers.length > 0) {
                        await tx.insert(teamMemberRolesTable).values(
                            teamMembers.map((teamMember) => ({
                                teamMemberId: teamMember.id,
                                role: roleByUserId.get(teamMember.userId) ?? "member",
                            }))
                        );
                    }

                    return {
                        team,
                        users: teamMembers.map((teamMember) => ({
                            teamId: teamMember.teamId,
                            userId: teamMember.userId,
                            role: roleByUserId.get(teamMember.userId) ?? "member",
                            createdAt: teamMember.createdAt,
                            updatedAt: null,
                        })),
                    };
                });
            });

            if (createResult.isErr()) {
                return mapTeamError(status, createResult.error);
            }

            return status(201, successResponse(createResult.value));
        },
        {
            body: z.object({
                name: z.string().min(1),
                users: z
                    .array(
                        z.object({
                            user_id: z.string(),
                            role: teamUserRoleSchema,
                        })
                    )
                    .optional(),
            }),
        }
    )
    .get(
        "/:id/available-users",
        async ({ status, params, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const usersResult = await Result.tryPromise(async () => {
                const access = await requireTeamMemberManageAccess(user, params.id);

                const members = await db
                    .select({
                        user_id: memberTable.userId,
                        user_name: userTable.name,
                        user_email: userTable.email,
                        role: memberTable.role,
                    })
                    .from(memberTable)
                    .innerJoin(userTable, eq(userTable.id, memberTable.userId))
                    .where(eq(memberTable.organizationId, access.team.organizationId))
                    .orderBy(asc(userTable.name), asc(userTable.email));

                return members;
            });

            if (usersResult.isErr()) {
                return mapTeamError(status, usersResult.error);
            }

            return status(200, successResponse(usersResult.value));
        },
        {
            params: z.object({
                id: z.string(),
            }),
        }
    )
    .get(
        "/:id/users",
        async ({ status, params, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const usersResult = await Result.tryPromise(async () => {
                await requireTeamAccess(user, params.id);
                return listTeamUsers(params.id);
            });

            if (usersResult.isErr()) {
                return mapTeamError(status, usersResult.error);
            }

            return status(200, successResponse(usersResult.value));
        },
        {
            params: z.object({
                id: z.string(),
            }),
        }
    )
    .post(
        "/:id/users",
        async ({ status, params, body, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const addResult = await Result.tryPromise(async () => {
                const access = await requireTeamMemberManageAccess(user, params.id);
                const role = body.role ?? "member";
                await ensureOrganizationMembers(access.team.organizationId, [body.user_id]);

                await db.transaction(async (tx) => {
                    const [existingMember] = await tx
                        .select({
                            user_id: teamMemberTable.userId,
                            role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                        })
                        .from(teamMemberTable)
                        .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                        .where(and(eq(teamMemberTable.teamId, params.id), eq(teamMemberTable.userId, body.user_id)))
                        .limit(1);

                    if (!access.organizationAdmin && (role === "admin" || existingMember?.role === "admin")) {
                        throw new Error(API_ERROR_CODES.FORBIDDEN);
                    }

                    const currentMembers = await tx
                        .select({
                            user_id: teamMemberTable.userId,
                            role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                        })
                        .from(teamMemberTable)
                        .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                        .where(eq(teamMemberTable.teamId, params.id));
                    const nextMembers = normalizeUsers({
                        users: currentMembers,
                        overrides: [{ user_id: body.user_id, role }],
                    });
                    ensureTeamHasAdmin(nextMembers);

                    const [teamMember] = await tx
                        .insert(teamMemberTable)
                        .values({
                            teamId: params.id,
                            userId: body.user_id,
                        })
                        .onConflictDoUpdate({
                            target: [teamMemberTable.teamId, teamMemberTable.userId],
                            set: {
                                teamId: params.id,
                            },
                        })
                        .returning({ id: teamMemberTable.id });

                    if (!teamMember) {
                        throw new Error(API_ERROR_CODES.INTERNAL_SERVER_ERROR);
                    }

                    await tx
                        .insert(teamMemberRolesTable)
                        .values({
                            teamMemberId: teamMember.id,
                            role,
                        })
                        .onConflictDoUpdate({
                            target: teamMemberRolesTable.teamMemberId,
                            set: {
                                role,
                            },
                        });
                });

                return listTeamUsers(params.id);
            });

            if (addResult.isErr()) {
                return mapTeamError(status, addResult.error);
            }

            return status(200, successResponse(addResult.value));
        },
        {
            params: z.object({
                id: z.string(),
            }),
            body: z.object({
                user_id: z.string(),
                role: teamUserRoleSchema.optional(),
            }),
        }
    )
    .patch(
        "/:id/users",
        async ({ status, params, body, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const updateUsersResult = await Result.tryPromise(async () => {
                const access = await requireTeamMemberManageAccess(user, params.id);
                const normalizedUsers = normalizeUsers({ users: body.users });
                await ensureOrganizationMembers(
                    access.team.organizationId,
                    normalizedUsers.map((teamUser) => teamUser.user_id)
                );

                await db.transaction(async (tx) => {
                    await tx
                        .select({ id: teamTable.id })
                        .from(teamTable)
                        .where(eq(teamTable.id, params.id))
                        .for("update");

                    const currentMembers = await tx
                        .select({
                            user_id: teamMemberTable.userId,
                            role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                        })
                        .from(teamMemberTable)
                        .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                        .where(eq(teamMemberTable.teamId, params.id))
                        .for("update", { of: teamMemberTable });

                    ensureTeamHasAdmin(normalizedUsers);

                    if (!access.organizationAdmin) {
                        const currentAdminIds = new Set(
                            currentMembers.filter((member) => member.role === "admin").map((member) => member.user_id)
                        );
                        const nextAdminIds = new Set(
                            normalizedUsers.filter((member) => member.role === "admin").map((member) => member.user_id)
                        );

                        if (
                            currentAdminIds.size !== nextAdminIds.size ||
                            [...currentAdminIds].some((userId) => !nextAdminIds.has(userId))
                        ) {
                            throw new Error(API_ERROR_CODES.FORBIDDEN);
                        }
                    }

                    await tx.delete(teamMemberTable).where(eq(teamMemberTable.teamId, params.id));

                    if (normalizedUsers.length === 0) {
                        return;
                    }

                    const roleByUserId = new Map(normalizedUsers.map((teamUser) => [teamUser.user_id, teamUser.role]));
                    const teamMembers = await tx
                        .insert(teamMemberTable)
                        .values(
                            normalizedUsers.map((teamUser) => ({
                                teamId: params.id,
                                userId: teamUser.user_id,
                            }))
                        )
                        .returning({
                            id: teamMemberTable.id,
                            userId: teamMemberTable.userId,
                        });

                    await tx.insert(teamMemberRolesTable).values(
                        teamMembers.map((teamMember) => ({
                            teamMemberId: teamMember.id,
                            role: roleByUserId.get(teamMember.userId) ?? "member",
                        }))
                    );
                });

                return listTeamUsers(params.id);
            });

            if (updateUsersResult.isErr()) {
                return mapTeamError(status, updateUsersResult.error);
            }

            return status(200, successResponse(updateUsersResult.value));
        },
        {
            params: z.object({
                id: z.string(),
            }),
            body: z.object({
                users: z.array(
                    z.object({
                        user_id: z.string(),
                        role: teamUserRoleSchema,
                    })
                ),
            }),
        }
    )
    .delete(
        "/:id/users/:userId",
        async ({ status, params, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const removeResult = await Result.tryPromise(async () => {
                const access = await requireTeamMemberManageAccess(user, params.id);

                await db.transaction(async (tx) => {
                    const currentMembers = await tx
                        .select({
                            user_id: teamMemberTable.userId,
                            role: sql<TeamMemberRole>`coalesce(${teamMemberRolesTable.role}, 'member')`,
                        })
                        .from(teamMemberTable)
                        .leftJoin(teamMemberRolesTable, eq(teamMemberRolesTable.teamMemberId, teamMemberTable.id))
                        .where(eq(teamMemberTable.teamId, params.id));
                    const existingMember = currentMembers.find((member) => member.user_id === params.userId);

                    if (!existingMember) {
                        return;
                    }

                    if (!access.organizationAdmin && existingMember.role === "admin") {
                        throw new Error(API_ERROR_CODES.FORBIDDEN);
                    }

                    ensureTeamHasAdmin(currentMembers.filter((member) => member.user_id !== params.userId));

                    await tx
                        .delete(teamMemberTable)
                        .where(and(eq(teamMemberTable.teamId, params.id), eq(teamMemberTable.userId, params.userId)));
                });

                return listTeamUsers(params.id);
            });

            if (removeResult.isErr()) {
                return mapTeamError(status, removeResult.error);
            }

            return status(200, successResponse(removeResult.value));
        },
        {
            params: z.object({
                id: z.string(),
                userId: z.string(),
            }),
        }
    )
    .patch(
        "/:id",
        async ({ status, body, params, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const patchResult = await Result.tryPromise(async () => {
                const membership = await requireOrganizationAdmin(user);
                const organizationId = membership.organizationId;

                const normalizedUsers = body.users ? normalizeUsers({ users: body.users }) : undefined;
                if (normalizedUsers) {
                    ensureTeamHasAdmin(normalizedUsers);
                    await ensureOrganizationMembers(
                        organizationId,
                        normalizedUsers.map((teamUser) => teamUser.user_id)
                    );
                }

                const team = await db.transaction(async (tx) => {
                    const [existingTeam] = await tx
                        .select({
                            id: teamTable.id,
                            name: teamTable.name,
                            organizationId: teamTable.organizationId,
                            createdAt: teamTable.createdAt,
                            updatedAt: teamTable.updatedAt,
                        })
                        .from(teamTable)
                        .where(and(eq(teamTable.id, params.id), eq(teamTable.organizationId, organizationId)))
                        .limit(1);

                    if (!existingTeam) {
                        throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
                    }

                    const [team] =
                        body.name !== undefined
                            ? await tx
                                  .update(teamTable)
                                  .set({ name: body.name })
                                  .where(eq(teamTable.id, params.id))
                                  .returning({
                                      id: teamTable.id,
                                      name: teamTable.name,
                                      organizationId: teamTable.organizationId,
                                      createdAt: teamTable.createdAt,
                                      updatedAt: teamTable.updatedAt,
                                  })
                            : [existingTeam];

                    if (normalizedUsers !== undefined) {
                        await tx.delete(teamMemberTable).where(eq(teamMemberTable.teamId, params.id));

                        if (normalizedUsers.length > 0) {
                            const roleByUserId = new Map(
                                normalizedUsers.map((teamUser) => [teamUser.user_id, teamUser.role])
                            );
                            const teamMembers = await tx
                                .insert(teamMemberTable)
                                .values(
                                    normalizedUsers.map((teamUser) => ({
                                        teamId: params.id,
                                        userId: teamUser.user_id,
                                    }))
                                )
                                .returning({
                                    id: teamMemberTable.id,
                                    userId: teamMemberTable.userId,
                                });

                            await tx.insert(teamMemberRolesTable).values(
                                teamMembers.map((teamMember) => ({
                                    teamMemberId: teamMember.id,
                                    role: roleByUserId.get(teamMember.userId) ?? "member",
                                }))
                            );
                        }
                    }

                    return team ?? existingTeam;
                });

                return {
                    team,
                    users: await listTeamUsers(params.id),
                };
            });

            if (patchResult.isErr()) {
                return mapTeamError(status, patchResult.error);
            }

            return status(200, successResponse(patchResult.value));
        },
        {
            params: z.object({
                id: z.string(),
            }),
            body: z.object({
                name: z.string().min(1).optional(),
                users: z
                    .array(
                        z.object({
                            user_id: z.string(),
                            role: teamUserRoleSchema,
                        })
                    )
                    .optional(),
            }),
        }
    )
    .delete(
        "/:id",
        async ({ status, params, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const graphDeleteScopeResult = await Result.tryPromise(async () => {
                const membership = await requireOrganizationAdmin(user);
                const organizationId = membership.organizationId;

                const [team] = await db
                    .select({ id: teamTable.id })
                    .from(teamTable)
                    .where(and(eq(teamTable.id, params.id), eq(teamTable.organizationId, organizationId)))
                    .limit(1);

                if (!team) {
                    throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
                }

                const directGraphRows = await db
                    .select({ id: graphTable.id })
                    .from(graphTable)
                    .where(eq(graphTable.teamId, params.id));

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
            });

            if (graphDeleteScopeResult.isErr()) {
                return mapTeamError(status, graphDeleteScopeResult.error);
            }

            const cancellationResult = await Result.tryPromise(async () => {
                const fileIdsByGraphId = new Map<string, string[]>();
                for (const file of graphDeleteScopeResult.value.fileRows) {
                    const fileIds = fileIdsByGraphId.get(file.graphId) ?? [];
                    fileIds.push(file.id);
                    fileIdsByGraphId.set(file.graphId, fileIds);
                }

                await Promise.all([
                    cancelActiveGraphWorkflowRuns(graphDeleteScopeResult.value.graphIds),
                    ...[...fileIdsByGraphId].map(([graphId, fileIds]) =>
                        cancelActiveFileProcessingWorkflowRuns(graphId, fileIds)
                    ),
                ]);
            });
            if (cancellationResult.isErr()) {
                logError("team workflow cancellation failed before team delete", {
                    teamId: params.id,
                    graphCount: graphDeleteScopeResult.value.graphIds.length,
                    fileCount: graphDeleteScopeResult.value.fileRows.length,
                    error: cancellationResult.error,
                });

                return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
            }

            const deleteResult = await Result.tryPromise(async () => {
                return db.transaction(async (tx) => {
                    const [team] = await tx
                        .select({ id: teamTable.id })
                        .from(teamTable)
                        .where(
                            and(
                                eq(teamTable.id, params.id),
                                eq(teamTable.organizationId, graphDeleteScopeResult.value.organizationId)
                            )
                        )
                        .limit(1);

                    if (!team) {
                        throw new Error(API_ERROR_CODES.TEAM_NOT_FOUND);
                    }

                    const graphIds = graphDeleteScopeResult.value.graphIds;
                    const fileRows = graphDeleteScopeResult.value.fileRows;

                    await tx.delete(teamTable).where(eq(teamTable.id, params.id));

                    return {
                        teamId: params.id,
                        graphIds,
                        fileRows,
                    };
                });
            });

            if (deleteResult.isErr()) {
                return mapTeamError(status, deleteResult.error);
            }

            const trackedKeys = deleteResult.value.fileRows.map((file) => file.key);
            const listedKeyResults = await Promise.allSettled(
                deleteResult.value.graphIds.map((graphId) => listFiles(`graphs/${graphId}/`, env.S3_BUCKET))
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
                const results = await Promise.allSettled(keys.map((key) => deleteFile(key, env.S3_BUCKET)));

                for (const result of results) {
                    if (result.status === "rejected") {
                        deleteFailureCount += 1;
                    }
                }
            }

            const failedKeyCount = listFailureCount + deleteFailureCount;
            if (failedKeyCount > 0) {
                logError("Team deleted with incomplete S3 cleanup", {
                    teamId: deleteResult.value.teamId,
                    graphCount: deleteResult.value.graphIds.length,
                    attemptedKeyCount: s3Keys.size,
                    failedKeyCount,
                });
            }

            return status(
                200,
                successResponse({
                    teamId: deleteResult.value.teamId,
                    deletedGraphCount: deleteResult.value.graphIds.length,
                    deletedFileCount: deleteResult.value.fileRows.length,
                    s3Cleanup: {
                        attemptedKeyCount: s3Keys.size,
                        failedKeyCount,
                    },
                    ...(failedKeyCount > 0
                        ? {
                              warnings: ["Some S3 objects could not be deleted after the team was removed"],
                          }
                        : {}),
                })
            );
        },
        {
            params: z.object({
                id: z.string(),
            }),
        }
    );
