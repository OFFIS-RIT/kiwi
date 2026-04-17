import Elysia from "elysia";
import { hasRole } from "@kiwi/auth/permissions";
import { error as logError } from "@kiwi/logger";
import { and, asc, eq, inArray } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";
import { Result } from "better-result";
import { db } from "@kiwi/db";
import { userTable } from "@kiwi/db/tables/auth";
import { filesTable, graphTable, groupTable, groupUserTable } from "@kiwi/db/tables/graph";
import { deleteFile, listFiles } from "@kiwi/files";
import z from "zod";
import { env } from "../env";
import { chunk } from "../lib/array";
import { collectGraphClosure } from "../lib/graph";
import { groupUserRoleSchema, normalizeGroupUsers } from "../lib/group";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

export const groupRoute = new Elysia({ prefix: "/groups" })
    .use(authMiddleware)
    .get(
        "/",
        async ({ status, user }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const groupsResult = await Result.tryPromise(async () => {
                if (hasRole(user.role, "admin")) {
                    const groups = await db
                        .select({
                            group_id: groupTable.id,
                            group_name: groupTable.name,
                        })
                        .from(groupTable)
                        .orderBy(asc(groupTable.name));

                    return groups.map((group) => ({
                        ...group,
                        role: "admin" as const,
                    }));
                }

                return db
                    .select({
                        group_id: groupTable.id,
                        group_name: groupTable.name,
                        role: groupUserTable.role,
                    })
                    .from(groupUserTable)
                    .innerJoin(groupTable, eq(groupTable.id, groupUserTable.groupId))
                    .where(eq(groupUserTable.userId, user.id))
                    .orderBy(asc(groupTable.name));
            });

            if (groupsResult.isErr()) {
                return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
            }

            return status(200, successResponse(groupsResult.value));
        },
        {
            beforeHandle: requirePermissions({
                group: ["view"],
            }),
        }
    )
    .post(
        "/",
        async ({ status, body, user }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const normalizedUsers = body.users ? normalizeGroupUsers(body.users, user.id) : [];

            const createResult = await Result.tryPromise(async () =>
                db.transaction(async (tx) => {
                    const [group] = await tx
                        .insert(groupTable)
                        .values({
                            name: body.name,
                            description: body.description,
                        })
                        .returning({ id: groupTable.id });

                    await tx.insert(groupUserTable).values({
                        role: "admin",
                        userId: user.id,
                        groupId: group.id,
                    });

                    if (normalizedUsers.length > 0) {
                        await tx.insert(groupUserTable).values(
                            normalizedUsers.map(({ userId, role }) => ({
                                role,
                                userId,
                                groupId: group.id,
                            }))
                        );
                    }

                    const users = await tx
                        .select({
                            groupId: groupUserTable.groupId,
                            userId: groupUserTable.userId,
                            role: groupUserTable.role,
                            createdAt: groupUserTable.createdAt,
                            updatedAt: groupUserTable.updatedAt,
                        })
                        .from(groupUserTable)
                        .where(eq(groupUserTable.groupId, group.id));

                    return {
                        group,
                        users,
                    };
                })
            );
            if (createResult.isErr()) {
                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            return status(201, {
                status: "success",
                data: createResult.value,
            });
        },
        {
            body: z.object({
                name: z.string(),
                description: z.string().optional(),
                users: z
                    .array(
                        z.object({
                            user_id: z.string(),
                            role: groupUserRoleSchema,
                        })
                    )
                    .optional(),
            }),
            beforeHandle: requirePermissions({
                group: ["create"],
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
                const [group] = await db
                    .select({ id: groupTable.id })
                    .from(groupTable)
                    .where(eq(groupTable.id, params.id))
                    .limit(1);

                if (!group) {
                    return status(404, errorResponse("Group not found", API_ERROR_CODES.GROUP_NOT_FOUND));
                }

                if (!hasRole(user.role, "admin")) {
                    const [membership] = await db
                        .select({ groupId: groupUserTable.groupId })
                        .from(groupUserTable)
                        .where(and(eq(groupUserTable.groupId, params.id), eq(groupUserTable.userId, user.id)))
                        .limit(1);

                    if (!membership) {
                        return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
                    }
                }

                const users = await db
                    .select({
                        group_id: groupUserTable.groupId,
                        user_id: groupUserTable.userId,
                        user_name: userTable.name,
                        role: groupUserTable.role,
                        created_at: groupUserTable.createdAt,
                        updated_at: groupUserTable.updatedAt,
                    })
                    .from(groupUserTable)
                    .innerJoin(userTable, eq(userTable.id, groupUserTable.userId))
                    .where(eq(groupUserTable.groupId, params.id))
                    .orderBy(asc(groupUserTable.userId));

                return status(
                    200,
                    successResponse(
                        users.map((user) => ({
                            group_id: user.group_id,
                            user_id: user.user_id,
                            user_name: user.user_name,
                            role: user.role,
                            created_at: user.created_at?.toISOString() ?? null,
                            updated_at: user.updated_at?.toISOString() ?? null,
                        }))
                    )
                );
            });

            if (usersResult.isErr()) {
                return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
            }

            return usersResult.value;
        },
        {
            params: z.object({
                id: z.string(),
            }),
            beforeHandle: requirePermissions({
                group: ["list:user"],
            }),
        }
    )
    .patch(
        "/:id",
        async ({ status, body, params, user }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const normalizedUsers = body.users ? normalizeGroupUsers(body.users) : undefined;

            const patchResult = await Result.tryPromise(async () =>
                db.transaction(async (tx) => {
                    const updateData: {
                        name?: string;
                        description?: string;
                    } = {};

                    if (body.name !== undefined) {
                        updateData.name = body.name;
                    }

                    if (body.description !== undefined) {
                        updateData.description = body.description;
                    }

                    const [group] =
                        Object.keys(updateData).length > 0
                            ? await tx
                                  .update(groupTable)
                                  .set(updateData)
                                  .where(eq(groupTable.id, params.id))
                                  .returning({
                                      id: groupTable.id,
                                      name: groupTable.name,
                                      description: groupTable.description,
                                      createdAt: groupTable.createdAt,
                                      updatedAt: groupTable.updatedAt,
                                  })
                            : await tx
                                  .select({
                                      id: groupTable.id,
                                      name: groupTable.name,
                                      description: groupTable.description,
                                      createdAt: groupTable.createdAt,
                                      updatedAt: groupTable.updatedAt,
                                  })
                                  .from(groupTable)
                                  .where(eq(groupTable.id, params.id))
                                  .limit(1);

                    if (!group) {
                        throw new Error("GROUP_NOT_FOUND");
                    }

                    if (normalizedUsers !== undefined) {
                        await tx.delete(groupUserTable).where(eq(groupUserTable.groupId, params.id));

                        if (normalizedUsers.length > 0) {
                            await tx.insert(groupUserTable).values(
                                normalizedUsers.map(({ userId, role }) => ({
                                    groupId: params.id,
                                    userId,
                                    role,
                                }))
                            );
                        }
                    }

                    const users = await tx
                        .select({
                            groupId: groupUserTable.groupId,
                            userId: groupUserTable.userId,
                            role: groupUserTable.role,
                            createdAt: groupUserTable.createdAt,
                            updatedAt: groupUserTable.updatedAt,
                        })
                        .from(groupUserTable)
                        .where(eq(groupUserTable.groupId, params.id));

                    return {
                        group,
                        users,
                    };
                })
            );

            if (patchResult.isErr()) {
                if (patchResult.error.message === "GROUP_NOT_FOUND") {
                    return status(404, {
                        status: "error",
                        message: "Group not found",
                        code: "GROUP_NOT_FOUND",
                    });
                }

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            return {
                status: "success",
                data: patchResult.value,
            };
        },
        {
            params: z.object({
                id: z.string(),
            }),
            body: z.object({
                name: z.string().optional(),
                description: z.string().optional(),
                users: z
                    .array(
                        z.object({
                            user_id: z.string(),
                            role: groupUserRoleSchema,
                        })
                    )
                    .optional(),
            }),
            beforeHandle: requirePermissions({
                group: ["update"],
            }),
        }
    )
    .delete(
        "/:id",
        async ({ status, params, user }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const deleteResult = await Result.tryPromise(async () =>
                db.transaction(async (tx) => {
                    const [group] = await tx
                        .select({ id: groupTable.id })
                        .from(groupTable)
                        .where(eq(groupTable.id, params.id))
                        .limit(1);

                    if (!group) {
                        throw new Error("GROUP_NOT_FOUND");
                    }

                    const directGraphRows = await tx
                        .select({ id: graphTable.id })
                        .from(graphTable)
                        .where(eq(graphTable.groupId, params.id));

                    const allGraphIds = await collectGraphClosure(
                        tx,
                        directGraphRows.map((graph) => graph.id)
                    );
                    const fileRows =
                        allGraphIds.length > 0
                            ? await tx
                                  .select({
                                      id: filesTable.id,
                                      graphId: filesTable.graphId,
                                      key: filesTable.key,
                                  })
                                  .from(filesTable)
                                  .where(inArray(filesTable.graphId, allGraphIds))
                            : [];

                    await tx.delete(groupTable).where(eq(groupTable.id, params.id));

                    return {
                        groupId: params.id,
                        graphIds: allGraphIds,
                        fileRows,
                    };
                })
            );

            if (deleteResult.isErr()) {
                if (deleteResult.error.message === "GROUP_NOT_FOUND") {
                    return status(404, {
                        status: "error",
                        message: "Group not found",
                        code: "GROUP_NOT_FOUND",
                    });
                }

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
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
            const S3_DELETE_BATCH_SIZE = 25;
            for (const keys of chunk([...s3Keys], S3_DELETE_BATCH_SIZE)) {
                const results = await Promise.allSettled(keys.map((key) => deleteFile(key, env.S3_BUCKET)));

                for (const result of results) {
                    if (result.status === "rejected") {
                        deleteFailureCount += 1;
                    }
                }
            }

            const failedKeyCount = listFailureCount + deleteFailureCount;
            if (failedKeyCount > 0) {
                logError("Group deleted with incomplete S3 cleanup", {
                    groupId: deleteResult.value.groupId,
                    graphCount: deleteResult.value.graphIds.length,
                    attemptedKeyCount: s3Keys.size,
                    failedKeyCount,
                });
            }

            return status(200, {
                status: "success",
                data: {
                    groupId: deleteResult.value.groupId,
                    deletedGraphCount: deleteResult.value.graphIds.length,
                    deletedFileCount: deleteResult.value.fileRows.length,
                    s3Cleanup: {
                        attemptedKeyCount: s3Keys.size,
                        failedKeyCount,
                    },
                    ...(failedKeyCount > 0
                        ? {
                              warnings: ["Some S3 objects could not be deleted after the group was removed"],
                          }
                        : {}),
                },
            });
        },
        {
            params: z.object({
                id: z.string(),
            }),
            beforeHandle: requirePermissions({
                group: ["delete"],
            }),
        }
    );
