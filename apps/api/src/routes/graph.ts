import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { Result } from "better-result";
import { Elysia, t } from "elysia";
import { db } from "@kiwi/db";
import { filesTable, graphTable, groupTable, groupUserTable } from "@kiwi/db/tables/graph";
import { deleteFile, getPresignedDownloadUrl, listFiles, putFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { deleteGraphFilesSpec } from "@kiwi/worker/delete-graph-files-spec";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import { env } from "../env";
import { chunk } from "../lib/array";
import { collectGraphClosure } from "../lib/graph";
import {
    assertCanCreateUnderParentGraph,
    assertCanPatchGraph,
    assertCanViewGraph,
    resolveGraphOwnerRoot,
    requireGroupUpdateAccess,
    type GraphRecord,
    selectGraphFields,
} from "../lib/graph-access";
import {
    cleanupUploadedKeys,
    cleanupFailedGraphCreation,
    mapGraphError,
    mapGraphListItemsWithProcessing,
    toGraphFileRecord,
    normalizeFiles,
    normalizeFileType,
    normalizeHidden,
    normalizeStringList,
    restoreGraphFileChangeFailure,
    selectFileFields,
    selectGraphListFields,
    selectGraphDetailFileFields,
    type CreatedFileRecord,
    type GraphFileRow,
    type UploadedFile,
} from "../lib/graph-route";
import type { GraphDetailFileRecord } from "../types/routes";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";
import { ow } from "../openworkflow";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

export const graphRoute = new Elysia({ prefix: "/graphs" })
    .use(authMiddleware)
    .get(
        "/",
        async ({ user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const graphsResult = await Result.tryPromise(async () => {
                if (user.role === "admin") {
                    const graphs = await db
                        .select(selectGraphListFields)
                        .from(graphTable)
                        .where(
                            and(isNotNull(graphTable.groupId), isNull(graphTable.graphId), eq(graphTable.hidden, false))
                        )
                        .orderBy(asc(graphTable.groupId), asc(graphTable.name));

                    return mapGraphListItemsWithProcessing(graphs);
                }

                const graphs = await db
                    .select(selectGraphListFields)
                    .from(graphTable)
                    .innerJoin(groupUserTable, eq(groupUserTable.groupId, graphTable.groupId))
                    .where(
                        and(
                            eq(groupUserTable.userId, user.id),
                            isNotNull(graphTable.groupId),
                            isNull(graphTable.graphId),
                            eq(graphTable.hidden, false)
                        )
                    )
                    .orderBy(asc(graphTable.groupId), asc(graphTable.name));

                return mapGraphListItemsWithProcessing(graphs);
            });

            if (graphsResult.isErr()) {
                return mapGraphError(status, graphsResult.error);
            }

            return status(200, successResponse(graphsResult.value));
        },
        {
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .get(
        "/:id/files",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const filesResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);

                const fileRows: GraphFileRow[] = await db
                    .select(selectGraphDetailFileFields)
                    .from(filesTable)
                    .where(and(eq(filesTable.graphId, params.id), eq(filesTable.deleted, false)))
                    .orderBy(asc(filesTable.createdAt), asc(filesTable.name));

                return fileRows.map(toGraphFileRecord);
            });

            if (filesResult.isErr()) {
                return mapGraphError(status, filesResult.error);
            }

            return status(200, successResponse(filesResult.value));
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["list:file"],
            }),
        }
    )
    .post(
        "/:id/file",
        async ({ body, params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const fileResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);

                const [file] = await db
                    .select({ key: filesTable.key })
                    .from(filesTable)
                    .where(
                        and(
                            eq(filesTable.graphId, params.id),
                            eq(filesTable.key, body.file_key),
                            eq(filesTable.deleted, false)
                        )
                    )
                    .limit(1);

                if (!file) {
                    return status(400, errorResponse("Invalid file IDs", API_ERROR_CODES.INVALID_FILE_IDS));
                }

                return status(200, successResponse({ url: getPresignedDownloadUrl(file.key, env.S3_BUCKET) }));
            });

            if (fileResult.isErr()) {
                return mapGraphError(status, fileResult.error);
            }

            return fileResult.value;
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            body: t.Object({
                file_key: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .get(
        "/:id",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const graphResult = await Result.tryPromise(async () => assertCanViewGraph(user, params.id));
            if (graphResult.isErr()) {
                return mapGraphError(status, graphResult.error);
            }
            const graph = graphResult.value;

            let groupId: string | null = null;
            let groupName: string | null = null;

            const detailResult = await Result.tryPromise(async () => {
                if (graph.groupId) {
                    const [group] = await db
                        .select({
                            id: groupTable.id,
                            name: groupTable.name,
                        })
                        .from(groupTable)
                        .where(eq(groupTable.id, graph.groupId))
                        .limit(1);

                    if (!group) {
                        throw new Error(API_ERROR_CODES.GROUP_NOT_FOUND);
                    }

                    groupId = group.id;
                    groupName = group.name;
                } else {
                    const rootOwner = await resolveGraphOwnerRoot(graph.id);

                    if (rootOwner.mode === "group") {
                        const [group] = await db
                            .select({
                                id: groupTable.id,
                                name: groupTable.name,
                            })
                            .from(groupTable)
                            .where(eq(groupTable.id, rootOwner.groupId))
                            .limit(1);

                        if (!group) {
                            throw new Error(API_ERROR_CODES.GROUP_NOT_FOUND);
                        }

                        groupId = group.id;
                        groupName = group.name;
                    }
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
                    group_id: groupId,
                    group_name: groupName,
                    files,
                };
            });

            if (detailResult.isErr()) {
                return mapGraphError(status, detailResult.error);
            }

            return status(200, {
                status: "success",
                data: detailResult.value,
            });
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["view"],
            }),
        }
    )
    .post(
        "/",
        async ({ body, request, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            if (body.groupId && body.graphId) {
                return status(400, {
                    status: "error",
                    message: "Only one owner may be specified",
                    code: API_ERROR_CODES.INVALID_GRAPH_OWNER,
                });
            }

            const files = normalizeFiles(body.files);
            const ownerMode = body.groupId ? "group" : body.graphId ? "graph" : "user";

            const accessResult = await Result.tryPromise(async () => {
                if (body.groupId) {
                    await requireGroupUpdateAccess(request.headers, user, body.groupId);
                } else if (body.graphId) {
                    await assertCanCreateUnderParentGraph(request.headers, user, body.graphId);
                }
            });

            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }

            const persistedHidden = body.groupId ? (normalizeHidden(body.hidden) ?? false) : true;
            const initialState = files.length > 0 ? "updating" : "ready";

            const [graph] = await db
                .insert(graphTable)
                .values({
                    name: body.name,
                    description: body.description,
                    hidden: persistedHidden,
                    state: initialState,
                    groupId: body.groupId,
                    graphId: body.graphId,
                    userId: ownerMode === "user" ? user.id : undefined,
                })
                .returning(selectGraphFields);

            if (!graph) {
                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            if (files.length === 0) {
                return status(201, {
                    status: "success",
                    data: {
                        graph,
                        files: [],
                        workflowRunId: null,
                    },
                });
            }

            const uploadedFiles: UploadedFile[] = [];
            try {
                for (const file of files) {
                    const upload = await putFile(file.name, file, `graphs/${graph.id}`, env.S3_BUCKET);

                    uploadedFiles.push({
                        name: file.name,
                        size: file.size,
                        type: normalizeFileType(file.name, file.type),
                        mimeType: file.type || upload.type,
                        key: upload.key,
                    });
                }
            } catch (uploadError) {
                await cleanupFailedGraphCreation(
                    graph.id,
                    uploadedFiles.map((file) => file.key),
                    "upload",
                    ownerMode
                );

                logError(
                    "graph creation failed during file upload",
                    "graphId",
                    graph.id,
                    "ownerMode",
                    ownerMode,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "error",
                    uploadError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            let createdFiles: CreatedFileRecord[] = [];

            try {
                createdFiles = await db
                    .insert(filesTable)
                    .values(
                        uploadedFiles.map((file) => ({
                            graphId: graph.id,
                            name: file.name,
                            size: file.size,
                            type: file.type,
                            mimeType: file.mimeType,
                            key: file.key,
                        }))
                    )
                    .returning(selectFileFields);
            } catch (dbInsertError) {
                await cleanupFailedGraphCreation(
                    graph.id,
                    uploadedFiles.map((file) => file.key),
                    "db_insert_files",
                    ownerMode
                );

                logError(
                    "graph creation failed during file row insert",
                    "graphId",
                    graph.id,
                    "ownerMode",
                    ownerMode,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "error",
                    dbInsertError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            try {
                const handle = await ow.runWorkflow(processFilesSpec, {
                    graphId: graph.id,
                    fileIds: createdFiles.map((file) => file.id),
                });

                return status(201, {
                    status: "success",
                    data: {
                        graph,
                        files: createdFiles,
                        workflowRunId: handle.workflowRun.id,
                    },
                });
            } catch (enqueueError) {
                await cleanupFailedGraphCreation(
                    graph.id,
                    uploadedFiles.map((file) => file.key),
                    "enqueue",
                    ownerMode
                );

                logError(
                    "graph creation failed during workflow enqueue",
                    "graphId",
                    graph.id,
                    "ownerMode",
                    ownerMode,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "error",
                    enqueueError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }
        },
        {
            body: t.Object({
                files: t.Optional(t.Files()),
                name: t.String(),
                description: t.Optional(t.String()),
                hidden: t.Optional(t.Union([t.Boolean(), t.Literal("true"), t.Literal("false")])),
                groupId: t.Optional(t.String()),
                graphId: t.Optional(t.String()),
            }),
            beforeHandle: requirePermissions({
                graph: ["create"],
            }),
        }
    )
    .patch(
        "/:id",
        async ({ body, params, request, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () =>
                assertCanPatchGraph(request.headers, user, params.id)
            );
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }
            const existingGraph = accessResult.value;

            const normalizedName = body.name === undefined ? undefined : body.name.trim();
            const normalizedDescription =
                body.description === undefined ? undefined : body.description === "" ? null : body.description;

            if (normalizedName !== undefined && normalizedName.length === 0) {
                return status(400, {
                    status: "error",
                    message: "Invalid name",
                    code: API_ERROR_CODES.INVALID_NAME,
                });
            }

            const updateData: Partial<Pick<GraphRecord, "name" | "description">> = {};

            if (normalizedName !== undefined && normalizedName !== existingGraph.name) {
                updateData.name = normalizedName;
            }

            if (normalizedDescription !== undefined && normalizedDescription !== existingGraph.description) {
                updateData.description = normalizedDescription;
            }

            if (Object.keys(updateData).length === 0) {
                return status(400, {
                    status: "error",
                    message: "No changes requested",
                    code: API_ERROR_CODES.NO_CHANGES,
                });
            }

            try {
                const [graph] = await db
                    .update(graphTable)
                    .set(updateData)
                    .where(eq(graphTable.id, existingGraph.id))
                    .returning(selectGraphFields);

                return status(200, {
                    status: "success",
                    data: {
                        graph: graph ?? existingGraph,
                    },
                });
            } catch (dbPatchError) {
                logError(
                    "graph patch failed during database update",
                    "graphId",
                    existingGraph.id,
                    "error",
                    dbPatchError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            body: t.Object({
                name: t.Optional(t.String()),
                description: t.Optional(t.String()),
            }),
            beforeHandle: requirePermissions({
                graph: ["update"],
            }),
        }
    )
    .post(
        "/:id/files",
        async ({ body, params, request, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () =>
                assertCanPatchGraph(request.headers, user, params.id)
            );
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }
            const existingGraph = accessResult.value;

            const files = normalizeFiles(body.files);
            if (files.length === 0) {
                return status(400, {
                    status: "error",
                    message: "No changes requested",
                    code: API_ERROR_CODES.NO_CHANGES,
                });
            }

            const uploadedFiles: UploadedFile[] = [];
            try {
                for (const file of files) {
                    const upload = await putFile(file.name, file, `graphs/${existingGraph.id}`, env.S3_BUCKET);

                    uploadedFiles.push({
                        name: file.name,
                        size: file.size,
                        type: normalizeFileType(file.name, file.type),
                        mimeType: file.type || upload.type,
                        key: upload.key,
                    });
                }
            } catch (uploadError) {
                const failedDeletes = await cleanupUploadedKeys(uploadedFiles.map((file) => file.key));

                logError(
                    "graph file add failed during file upload",
                    "graphId",
                    existingGraph.id,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "failedS3CleanupCount",
                    failedDeletes,
                    "error",
                    uploadError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            let graph = existingGraph;
            let addedFiles: CreatedFileRecord[] = [];

            try {
                const result = await db.transaction(async (tx) => {
                    const [updatedGraph] = await tx
                        .update(graphTable)
                        .set({ state: "updating" })
                        .where(eq(graphTable.id, existingGraph.id))
                        .returning(selectGraphFields);

                    const insertedFiles = await tx
                        .insert(filesTable)
                        .values(
                            uploadedFiles.map((file) => ({
                                graphId: existingGraph.id,
                                name: file.name,
                                size: file.size,
                                type: file.type,
                                mimeType: file.mimeType,
                                key: file.key,
                            }))
                        )
                        .returning(selectFileFields);

                    return {
                        graph: updatedGraph ?? existingGraph,
                        addedFiles: insertedFiles,
                    };
                });

                graph = result.graph;
                addedFiles = result.addedFiles;
            } catch (dbPatchError) {
                const failedDeletes = await cleanupUploadedKeys(uploadedFiles.map((file) => file.key));

                logError(
                    "graph file add failed during database update",
                    "graphId",
                    existingGraph.id,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "failedS3CleanupCount",
                    failedDeletes,
                    "error",
                    dbPatchError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            try {
                const handle = await ow.runWorkflow(processFilesSpec, {
                    graphId: existingGraph.id,
                    fileIds: addedFiles.map((file) => file.id),
                });

                return status(200, {
                    status: "success",
                    data: {
                        graph,
                        addedFiles,
                        workflowRunId: handle.workflowRun.id,
                    },
                });
            } catch (enqueueError) {
                await restoreGraphFileChangeFailure(
                    existingGraph.id,
                    existingGraph,
                    addedFiles.map((file) => file.id),
                    uploadedFiles.map((file) => file.key)
                );

                logError(
                    "graph file add failed during workflow enqueue",
                    "graphId",
                    existingGraph.id,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "addedFileCount",
                    addedFiles.length,
                    "error",
                    enqueueError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            body: t.Object({
                files: t.Optional(t.Files()),
            }),
            beforeHandle: requirePermissions({
                graph: ["add:file"],
            }),
        }
    )
    .delete(
        "/:id/files",
        async ({ body, params, request, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () =>
                assertCanPatchGraph(request.headers, user, params.id)
            );
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }
            const existingGraph = accessResult.value;

            const fileKeys = normalizeStringList(body.fileKeys);
            if (fileKeys.length === 0) {
                return status(400, {
                    status: "error",
                    message: "No changes requested",
                    code: API_ERROR_CODES.NO_CHANGES,
                });
            }

            const existingFiles = await db
                .select({
                    id: filesTable.id,
                    key: filesTable.key,
                })
                .from(filesTable)
                .where(and(eq(filesTable.graphId, existingGraph.id), eq(filesTable.deleted, false)));

            const fileIdByKey = new Map(existingFiles.map((file) => [file.key, file.id]));
            const hasInvalidFileKeys = fileKeys.some((fileKey) => !fileIdByKey.has(fileKey));

            if (hasInvalidFileKeys) {
                return status(400, {
                    status: "error",
                    message: "Invalid file IDs",
                    code: API_ERROR_CODES.INVALID_FILE_IDS,
                });
            }

            let graph = existingGraph;
            try {
                const [updatedGraph] = await db
                    .update(graphTable)
                    .set({ state: "updating" })
                    .where(eq(graphTable.id, existingGraph.id))
                    .returning(selectGraphFields);

                graph = updatedGraph ?? existingGraph;
            } catch (dbPatchError) {
                logError(
                    "graph file delete failed during database update",
                    "graphId",
                    existingGraph.id,
                    "removedFileCount",
                    fileKeys.length,
                    "error",
                    dbPatchError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            try {
                const handle = await ow.runWorkflow(deleteGraphFilesSpec, {
                    graphId: existingGraph.id,
                    fileIds: fileKeys.map((fileKey) => fileIdByKey.get(fileKey)!),
                });

                return status(200, {
                    status: "success",
                    data: {
                        graph,
                        removedFileKeys: fileKeys,
                        workflowRunId: handle.workflowRun.id,
                    },
                });
            } catch (enqueueError) {
                try {
                    await db.update(graphTable).set({ state: existingGraph.state }).where(eq(graphTable.id, existingGraph.id));
                } catch (restoreError) {
                    logError(
                        "failed to restore graph state after file delete enqueue failure",
                        "graphId",
                        existingGraph.id,
                        "removedFileCount",
                        fileKeys.length,
                        "error",
                        restoreError
                    );
                }

                logError(
                    "graph file delete failed during workflow enqueue",
                    "graphId",
                    existingGraph.id,
                    "removedFileCount",
                    fileKeys.length,
                    "error",
                    enqueueError
                );

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            body: t.Object({
                fileKeys: t.Optional(t.Union([t.String(), t.Array(t.String())])),
            }),
            beforeHandle: requirePermissions({
                graph: ["delete:file"],
            }),
        }
    )
    .delete(
        "/:id",
        async ({ params, request, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () =>
                assertCanPatchGraph(request.headers, user, params.id)
            );
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }

            let deleteResult: {
                graphId: string;
                graphIds: string[];
                fileRows: Array<{
                    id: string;
                    graphId: string;
                    key: string;
                }>;
            };

            const deleteGraphResult = await Result.tryPromise(async () =>
                db.transaction(async (tx) => {
                    const [graph] = await tx
                        .select({ id: graphTable.id })
                        .from(graphTable)
                        .where(eq(graphTable.id, params.id))
                        .limit(1);

                    if (!graph) {
                        throw new Error(API_ERROR_CODES.GRAPH_NOT_FOUND);
                    }

                    const graphIds = await collectGraphClosure(tx, [params.id]);
                    const fileRows = await tx
                        .select({
                            id: filesTable.id,
                            graphId: filesTable.graphId,
                            key: filesTable.key,
                        })
                        .from(filesTable)
                        .where(inArray(filesTable.graphId, graphIds));

                    await tx.delete(graphTable).where(eq(graphTable.id, params.id));

                    return {
                        graphId: params.id,
                        graphIds,
                        fileRows,
                    };
                })
            );
            if (deleteGraphResult.isErr()) {
                if (deleteGraphResult.error instanceof Error && deleteGraphResult.error.message === API_ERROR_CODES.GRAPH_NOT_FOUND) {
                    return status(404, {
                        status: "error",
                        message: "Graph not found",
                        code: API_ERROR_CODES.GRAPH_NOT_FOUND,
                    });
                }

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            deleteResult = deleteGraphResult.value;

            const s3Keys = new Set(deleteResult.fileRows.map((file) => file.key));
            const listedKeyResults = await Promise.allSettled(
                deleteResult.graphIds.map((graphId) => listFiles(`graphs/${graphId}/`, env.S3_BUCKET))
            );

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
                const deleteResults = await Promise.allSettled(keys.map((key) => deleteFile(key, env.S3_BUCKET)));

                for (const result of deleteResults) {
                    if (result.status === "rejected") {
                        deleteFailureCount += 1;
                    }
                }
            }

            const failedKeyCount = listFailureCount + deleteFailureCount;
            if (failedKeyCount > 0) {
                logError(
                    "Graph deleted with incomplete S3 cleanup",
                    "graphId",
                    deleteResult.graphId,
                    "graphCount",
                    deleteResult.graphIds.length,
                    "attemptedKeyCount",
                    s3Keys.size,
                    "failedKeyCount",
                    failedKeyCount
                );
            }

            return status(200, {
                status: "success",
                data: {
                    graphId: deleteResult.graphId,
                    deletedGraphCount: deleteResult.graphIds.length,
                    deletedFileCount: deleteResult.fileRows.length,
                    s3Cleanup: {
                        attemptedKeyCount: s3Keys.size,
                        failedKeyCount,
                    },
                    ...(failedKeyCount > 0
                        ? {
                              warnings: ["Some S3 objects could not be deleted after the graph was removed"],
                          }
                        : {}),
                },
            });
        },
        {
            params: t.Object({
                id: t.String(),
            }),
            beforeHandle: requirePermissions({
                graph: ["delete"],
            }),
        }
    );
