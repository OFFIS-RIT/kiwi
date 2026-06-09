import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Result } from "better-result";
import { Elysia, t } from "elysia";
import { ulid } from "ulid";
import { db } from "@kiwi/db";
import { filesTable, graphTable, processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import { teamTable } from "@kiwi/db/tables/auth";
import { deleteFile, listFiles, putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { deleteGraphFilesSpec } from "@kiwi/worker/delete-graph-files-spec";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import { env } from "../env";
import { chunk } from "../lib/array";
import { collectGraphClosure } from "../lib/graph";
import { listAccessibleGraphs } from "../lib/graph-list";
import { cancelActiveFileProcessingWorkflowRuns, cancelActiveGraphWorkflowRuns } from "../lib/workflow-cancellation";
import {
    assertCanCreateTopLevelGraph,
    assertCanCreateUnderParentGraph,
    assertCanCreateTeamGraph,
    assertCanManageGraphFiles,
    assertCanPatchGraph,
    assertCanViewGraph,
    resolveGraphOwnerRoot,
    type GraphRecord,
    selectGraphFields,
} from "../lib/graph-access";
import {
    cleanupUploadedKeys,
    cleanupFailedGraphCreation,
    mapGraphError,
    toGraphFileRecord,
    inferSupportedUploadedFiles,
    restoreGraphFileChangeFailure,
    selectFileFields,
    selectGraphDetailFileFields,
    unsupportedUploadResponse,
    uniqueFilesByChecksum,
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

            const graphsResult = await Result.tryPromise(async () => listAccessibleGraphs(user));

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

            let teamId: string | null = null;
            let teamName: string | null = null;

            const detailResult = await Result.tryPromise(async () => {
                const rootOwner = await resolveGraphOwnerRoot(graph.id);

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
        async ({ body, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            if (body.teamId && body.graphId) {
                return status(400, {
                    status: "error",
                    message: "Only one owner may be specified",
                    code: API_ERROR_CODES.INVALID_GRAPH_OWNER,
                });
            }

            const files = body.files ? (Array.isArray(body.files) ? body.files : [body.files]) : [];

            const ownerResult = await Result.tryPromise(async () => {
                if (body.teamId) {
                    const access = await assertCanCreateTeamGraph(user, body.teamId);
                    return {
                        ownerMode: "team" as const,
                        organizationId: access.team.organizationId,
                        teamId: body.teamId,
                    };
                }

                if (body.graphId) {
                    await assertCanCreateUnderParentGraph(user, body.graphId);
                    return {
                        ownerMode: "graph" as const,
                        graphId: body.graphId,
                    };
                }

                const access = await assertCanCreateTopLevelGraph(user);
                return {
                    ownerMode: "organization" as const,
                    organizationId: access.organizationId,
                };
            });

            if (ownerResult.isErr()) {
                return mapGraphError(status, ownerResult.error);
            }

            const owner = ownerResult.value;
            const ownerMode = owner.ownerMode;
            const filesWithChecksums = await uniqueFilesByChecksum(files);
            const supportedUpload = inferSupportedUploadedFiles(filesWithChecksums);
            if (!supportedUpload.ok) {
                return unsupportedUploadResponse(status, supportedUpload);
            }

            const hidden = owner.ownerMode === "graph" ? true : body.hidden === true || body.hidden === "true";
            const initialState = supportedUpload.files.length > 0 ? "updating" : "ready";

            const [graph] = await db
                .insert(graphTable)
                .values({
                    name: body.name,
                    description: body.description,
                    hidden,
                    state: initialState,
                    organizationId: owner.ownerMode === "graph" ? undefined : owner.organizationId,
                    teamId: owner.ownerMode === "team" ? owner.teamId : undefined,
                    graphId: owner.ownerMode === "graph" ? owner.graphId : undefined,
                })
                .returning(selectGraphFields);

            if (!graph) {
                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            if (supportedUpload.files.length === 0) {
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
                for (const { file, checksum, type } of supportedUpload.files) {
                    const fileId = ulid();
                    const upload = await putGraphFile(graph.id, fileId, file.name, file, env.S3_BUCKET);

                    uploadedFiles.push({
                        id: fileId,
                        name: file.name,
                        size: file.size,
                        type,
                        mimeType: file.type || upload.type,
                        key: upload.key,
                        checksum,
                    });
                }
            } catch (uploadError) {
                await cleanupFailedGraphCreation(
                    graph.id,
                    uploadedFiles.map((file) => file.key),
                    "upload",
                    ownerMode
                );

                logError("graph creation failed during file upload", {
                    graphId: graph.id,
                    ownerMode,
                    uploadedKeyCount: uploadedFiles.length,
                    error: uploadError,
                });

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
                            id: file.id,
                            graphId: graph.id,
                            name: file.name,
                            size: file.size,
                            type: file.type,
                            mimeType: file.mimeType,
                            key: file.key,
                            checksum: file.checksum,
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

                logError("graph creation failed during file row insert", {
                    graphId: graph.id,
                    ownerMode,
                    uploadedKeyCount: uploadedFiles.length,
                    error: dbInsertError,
                });

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            try {
                const [processRun] = await db
                    .insert(processRunsTable)
                    .values({
                        graphId: graph.id,
                        status: "pending",
                    })
                    .returning({ id: processRunsTable.id });
                if (!processRun) {
                    throw new Error("Failed to create process run");
                }

                await db.insert(processRunFilesTable).values(
                    createdFiles.map((file) => ({
                        processRunId: processRun.id,
                        fileId: file.id,
                    }))
                );

                const handle = await ow.runWorkflow(processFilesSpec, {
                    graphId: graph.id,
                    fileIds: createdFiles.map((file) => file.id),
                    processRunId: processRun.id,
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

                logError("graph creation failed during workflow enqueue", {
                    graphId: graph.id,
                    ownerMode,
                    uploadedKeyCount: uploadedFiles.length,
                    error: enqueueError,
                });

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
                teamId: t.Optional(t.String()),
                graphId: t.Optional(t.String()),
            }),
        }
    )
    .patch(
        "/:id",
        async ({ body, params, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () => assertCanPatchGraph(user, params.id));
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }
            const existingGraph = accessResult.value;

            const name = body.name?.trim();
            const description = body.description === undefined ? undefined : body.description || null;

            if (body.name !== undefined && !name) {
                return status(400, {
                    status: "error",
                    message: "Invalid name",
                    code: API_ERROR_CODES.INVALID_NAME,
                });
            }

            const updateData: Partial<Pick<GraphRecord, "name" | "description">> = {};

            if (name !== undefined && name !== existingGraph.name) {
                updateData.name = name;
            }

            if (description !== undefined && description !== existingGraph.description) {
                updateData.description = description;
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
                logError("graph patch failed during database update", {
                    graphId: existingGraph.id,
                    error: dbPatchError,
                });

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
        }
    )
    .post(
        "/:id/files",
        async ({ body, params, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () => assertCanManageGraphFiles(user, params.id));
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }
            const existingGraph = accessResult.value;

            const files = body.files ? (Array.isArray(body.files) ? body.files : [body.files]) : [];
            if (files.length === 0) {
                return status(400, {
                    status: "error",
                    message: "No changes requested",
                    code: API_ERROR_CODES.NO_CHANGES,
                });
            }

            const uniqueUploadedFiles = await uniqueFilesByChecksum(files);
            if (uniqueUploadedFiles.length === 0) {
                return status(200, {
                    status: "success",
                    data: {
                        graph: existingGraph,
                        addedFiles: [],
                        workflowRunId: null,
                    },
                });
            }

            const existingFiles = await db
                .select({ checksum: filesTable.checksum })
                .from(filesTable)
                .where(
                    and(
                        eq(filesTable.graphId, existingGraph.id),
                        eq(filesTable.deleted, false),
                        isNotNull(filesTable.checksum)
                    )
                );
            const existingChecksums = new Set(
                existingFiles.map((file) => file.checksum).filter((checksum) => checksum !== null)
            );
            const filesWithChecksums = uniqueUploadedFiles.filter((file) => !existingChecksums.has(file.checksum));

            if (filesWithChecksums.length === 0) {
                return status(200, {
                    status: "success",
                    data: {
                        graph: existingGraph,
                        addedFiles: [],
                        workflowRunId: null,
                    },
                });
            }

            const supportedUpload = inferSupportedUploadedFiles(filesWithChecksums);
            if (!supportedUpload.ok) {
                return unsupportedUploadResponse(status, supportedUpload);
            }

            const uploadedFiles: UploadedFile[] = [];
            try {
                for (const { file, checksum, type } of supportedUpload.files) {
                    const fileId = ulid();
                    const upload = await putGraphFile(existingGraph.id, fileId, file.name, file, env.S3_BUCKET);

                    uploadedFiles.push({
                        id: fileId,
                        name: file.name,
                        size: file.size,
                        type,
                        mimeType: file.type || upload.type,
                        key: upload.key,
                        checksum,
                    });
                }
            } catch (uploadError) {
                const failedDeletes = await cleanupUploadedKeys(uploadedFiles.map((file) => file.key));

                logError("graph file add failed during file upload", {
                    graphId: existingGraph.id,
                    uploadedKeyCount: uploadedFiles.length,
                    failedS3CleanupCount: failedDeletes,
                    error: uploadError,
                });

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            let graph = existingGraph;
            let addedFiles: CreatedFileRecord[] = [];
            let processRunId: string | undefined;

            try {
                const result = await db.transaction(async (tx) => {
                    const insertedFiles = await tx
                        .insert(filesTable)
                        .values(
                            uploadedFiles.map((file) => ({
                                id: file.id,
                                graphId: existingGraph.id,
                                name: file.name,
                                size: file.size,
                                type: file.type,
                                mimeType: file.mimeType,
                                key: file.key,
                                checksum: file.checksum,
                            }))
                        )
                        .onConflictDoNothing()
                        .returning(selectFileFields);

                    if (insertedFiles.length === 0) {
                        return {
                            graph: existingGraph,
                            addedFiles: insertedFiles,
                            processRunId: undefined,
                        };
                    }

                    const [updatedGraph] = await tx
                        .update(graphTable)
                        .set({ state: "updating" })
                        .where(eq(graphTable.id, existingGraph.id))
                        .returning(selectGraphFields);

                    const [processRun] = await tx
                        .insert(processRunsTable)
                        .values({
                            graphId: existingGraph.id,
                            status: "pending",
                        })
                        .returning({ id: processRunsTable.id });
                    if (!processRun) {
                        throw new Error("Failed to create process run");
                    }

                    await tx.insert(processRunFilesTable).values(
                        insertedFiles.map((file) => ({
                            processRunId: processRun.id,
                            fileId: file.id,
                        }))
                    );

                    return {
                        graph: updatedGraph ?? existingGraph,
                        addedFiles: insertedFiles,
                        processRunId: processRun.id,
                    };
                });

                graph = result.graph;
                addedFiles = result.addedFiles;
                processRunId = result.processRunId;

                const addedKeys = new Set(addedFiles.map((file) => file.key));
                const skippedKeys = uploadedFiles.map((file) => file.key).filter((key) => !addedKeys.has(key));
                if (skippedKeys.length > 0) {
                    await cleanupUploadedKeys(skippedKeys);
                }
            } catch (dbPatchError) {
                const failedDeletes = await cleanupUploadedKeys(uploadedFiles.map((file) => file.key));

                logError("graph file add failed during database update", {
                    graphId: existingGraph.id,
                    uploadedKeyCount: uploadedFiles.length,
                    failedS3CleanupCount: failedDeletes,
                    error: dbPatchError,
                });

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            if (addedFiles.length === 0) {
                return status(200, {
                    status: "success",
                    data: {
                        graph,
                        addedFiles,
                        workflowRunId: null,
                    },
                });
            }

            try {
                if (!processRunId) {
                    throw new Error("Missing process run id");
                }

                const handle = await ow.runWorkflow(processFilesSpec, {
                    graphId: existingGraph.id,
                    fileIds: addedFiles.map((file) => file.id),
                    processRunId,
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
                    uploadedFiles.map((file) => file.key),
                    processRunId
                );

                logError("graph file add failed during workflow enqueue", {
                    graphId: existingGraph.id,
                    uploadedKeyCount: uploadedFiles.length,
                    addedFileCount: addedFiles.length,
                    error: enqueueError,
                });

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
        }
    )
    .post(
        "/:id/files/:fileId/retry",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () => assertCanManageGraphFiles(user, params.id));
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }
            const existingGraph = accessResult.value;

            const [file] = await db
                .select({
                    id: filesTable.id,
                    status: filesTable.status,
                    processStep: filesTable.processStep,
                    processErrorCode: filesTable.processErrorCode,
                })
                .from(filesTable)
                .where(
                    and(
                        eq(filesTable.graphId, existingGraph.id),
                        eq(filesTable.id, params.fileId),
                        eq(filesTable.deleted, false)
                    )
                )
                .limit(1);

            if (!file) {
                return status(400, {
                    status: "error",
                    message: "Invalid file IDs",
                    code: API_ERROR_CODES.INVALID_FILE_IDS,
                });
            }

            if (file.processStep !== "failed") {
                return status(400, {
                    status: "error",
                    message: "File is not in a failed state",
                    code: API_ERROR_CODES.INVALID_FILE_IDS,
                });
            }

            let retry: { graph: GraphRecord; runId: string };

            try {
                retry = await db.transaction(async (tx) => {
                    const [updatedGraph] = await tx
                        .update(graphTable)
                        .set({ state: "updating" })
                        .where(eq(graphTable.id, existingGraph.id))
                        .returning(selectGraphFields);

                    const [processRun] = await tx
                        .insert(processRunsTable)
                        .values({
                            graphId: existingGraph.id,
                            status: "pending",
                        })
                        .returning({ id: processRunsTable.id });
                    if (!processRun) {
                        throw new Error("Failed to create process run");
                    }

                    await tx.insert(processRunFilesTable).values({
                        processRunId: processRun.id,
                        fileId: file.id,
                    });

                    // Reset the file so it immediately reads as "processing" again. This makes the
                    // existing status-polling resume and clears the stale failure reason in the UI.
                    await tx
                        .update(filesTable)
                        .set({ status: "processing", processStep: "pending", processErrorCode: null })
                        .where(eq(filesTable.id, file.id));

                    return {
                        graph: updatedGraph ?? existingGraph,
                        runId: processRun.id,
                    };
                });
            } catch (dbPatchError) {
                logError("graph file retry failed during database update", {
                    graphId: existingGraph.id,
                    fileId: file.id,
                    error: dbPatchError,
                });

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            try {
                const handle = await ow.runWorkflow(processFilesSpec, {
                    graphId: existingGraph.id,
                    fileIds: [file.id],
                    processRunId: retry.runId,
                });

                return status(200, {
                    status: "success",
                    data: {
                        graph: retry.graph,
                        fileId: file.id,
                        workflowRunId: handle.workflowRun.id,
                    },
                });
            } catch (enqueueError) {
                try {
                    await db.transaction(async (tx) => {
                        await tx.delete(processRunsTable).where(eq(processRunsTable.id, retry.runId));

                        await tx
                            .update(graphTable)
                            .set({ state: existingGraph.state })
                            .where(eq(graphTable.id, existingGraph.id));

                        await tx
                            .update(filesTable)
                            .set({
                                status: file.status,
                                processStep: file.processStep,
                                processErrorCode: file.processErrorCode,
                            })
                            .where(eq(filesTable.id, file.id));
                    });
                } catch (restoreError) {
                    logError("failed to restore graph state after file retry enqueue failure", {
                        graphId: existingGraph.id,
                        fileId: file.id,
                        error: restoreError,
                    });
                }

                logError("graph file retry failed during workflow enqueue", {
                    graphId: existingGraph.id,
                    fileId: file.id,
                    error: enqueueError,
                });

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
                fileId: t.String(),
            }),
        }
    )
    .delete(
        "/:id/files",
        async ({ body, params, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () => assertCanManageGraphFiles(user, params.id));
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }
            const existingGraph = accessResult.value;

            const fileKeys = body.fileKeys
                ? [
                      ...new Set(
                          (Array.isArray(body.fileKeys) ? body.fileKeys : [body.fileKeys]).filter(
                              (fileKey) => fileKey.length > 0
                          )
                      ),
                  ]
                : [];
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

            const fileIds = fileKeys.map((fileKey) => fileIdByKey.get(fileKey)!);
            let graph = existingGraph;
            try {
                const [updatedGraph] = await db.transaction(async (tx) => {
                    const updatedGraphs = await tx
                        .update(graphTable)
                        .set({ state: "updating" })
                        .where(eq(graphTable.id, existingGraph.id))
                        .returning(selectGraphFields);

                    await tx
                        .update(filesTable)
                        .set({ deleted: true })
                        .where(and(eq(filesTable.graphId, existingGraph.id), inArray(filesTable.id, fileIds)));

                    return updatedGraphs;
                });

                graph = updatedGraph ?? existingGraph;
            } catch (dbPatchError) {
                logError("graph file delete failed during database update", {
                    graphId: existingGraph.id,
                    removedFileCount: fileKeys.length,
                    error: dbPatchError,
                });

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            try {
                const handle = await ow.runWorkflow(deleteGraphFilesSpec, {
                    graphId: existingGraph.id,
                    fileIds,
                });
                const cancellationResult = await Result.tryPromise(async () =>
                    cancelActiveFileProcessingWorkflowRuns(existingGraph.id, fileIds)
                );
                if (cancellationResult.isErr()) {
                    logError("graph file processing workflow cancellation failed after delete enqueue", {
                        graphId: existingGraph.id,
                        removedFileCount: fileKeys.length,
                        workflowRunId: handle.workflowRun.id,
                        error: cancellationResult.error,
                    });
                }

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
                    await db.transaction(async (tx) => {
                        await tx
                            .update(filesTable)
                            .set({ deleted: false })
                            .where(and(eq(filesTable.graphId, existingGraph.id), inArray(filesTable.id, fileIds)));

                        await tx
                            .update(graphTable)
                            .set({ state: existingGraph.state })
                            .where(eq(graphTable.id, existingGraph.id));
                    });
                } catch (restoreError) {
                    logError("failed to restore graph state after file delete enqueue failure", {
                        graphId: existingGraph.id,
                        removedFileCount: fileKeys.length,
                        error: restoreError,
                    });
                }

                logError("graph file delete failed during workflow enqueue", {
                    graphId: existingGraph.id,
                    removedFileCount: fileKeys.length,
                    error: enqueueError,
                });

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
        }
    )
    .delete(
        "/:id",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, {
                    status: "error",
                    message: "Unauthorized",
                    code: "UNAUTHORIZED",
                });
            }

            const accessResult = await Result.tryPromise(async () => assertCanPatchGraph(user, params.id));
            if (accessResult.isErr()) {
                return mapGraphError(status, accessResult.error);
            }

            const graphIdsResult = await Result.tryPromise(async () => collectGraphClosure(db, [params.id]));
            if (graphIdsResult.isErr()) {
                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

            const cancellationResult = await Result.tryPromise(async () =>
                cancelActiveGraphWorkflowRuns(graphIdsResult.value)
            );
            if (cancellationResult.isErr()) {
                logError("graph workflow cancellation failed before graph delete", {
                    graphId: params.id,
                    graphCount: graphIdsResult.value.length,
                    error: cancellationResult.error,
                });

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
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
                if (
                    deleteGraphResult.error instanceof Error &&
                    deleteGraphResult.error.message === API_ERROR_CODES.GRAPH_NOT_FOUND
                ) {
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
                logError("Graph deleted with incomplete S3 cleanup", {
                    graphId: deleteResult.graphId,
                    graphCount: deleteResult.graphIds.length,
                    attemptedKeyCount: s3Keys.size,
                    failedKeyCount,
                });
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
        }
    );
