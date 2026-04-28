import { hasRole } from "@kiwi/auth/permissions";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { Result } from "better-result";
import { Elysia, t } from "elysia";
import { db } from "@kiwi/db";
import {
    filesTable,
    graphTable,
    groupTable,
    groupUserTable,
    processRunFilesTable,
    processRunsTable,
    textUnitTable,
} from "@kiwi/db/tables/graph";
import { deleteFile, getPresignedDownloadUrl, listFiles, putFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { deleteGraphFilesSpec } from "@kiwi/worker/delete-graph-files-spec";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import { env } from "../env";
import { chunk } from "../lib/array";
import { collectGraphClosure } from "../lib/graph";
import { mapUnitError } from "../lib/unit";
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
    restoreGraphFileChangeFailure,
    selectFileFields,
    selectGraphListFields,
    selectGraphDetailFileFields,
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

            const graphsResult = await Result.tryPromise(async () => {
                if (hasRole(user.role, "admin")) {
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
        "/:id/units/:unitId",
        async ({ params, user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            const unitResult = await Result.tryPromise(async () => {
                await assertCanViewGraph(user, params.id);

                const [unit] = await db
                    .select({
                        id: textUnitTable.id,
                        project_file_id: textUnitTable.fileId,
                        text: textUnitTable.text,
                        created_at: textUnitTable.createdAt,
                        updated_at: textUnitTable.updatedAt,
                    })
                    .from(textUnitTable)
                    .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
                    .where(and(eq(textUnitTable.id, params.unitId), eq(filesTable.graphId, params.id)))
                    .limit(1);

                if (!unit) {
                    throw new Error(API_ERROR_CODES.TEXT_UNIT_NOT_FOUND);
                }

                return {
                    id: unit.id,
                    project_file_id: unit.project_file_id,
                    text: unit.text,
                    created_at: unit.created_at?.toISOString() ?? null,
                    updated_at: unit.updated_at?.toISOString() ?? null,
                };
            });

            if (unitResult.isErr()) {
                return mapUnitError(status, unitResult.error);
            }

            return status(200, successResponse(unitResult.value));
        },
        {
            params: t.Object({
                id: t.String(),
                unitId: t.String(),
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

            const files = body.files ? (Array.isArray(body.files) ? body.files : [body.files]) : [];
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

            const filesWithChecksums = await uniqueFilesByChecksum(files);
            const hidden = body.groupId ? body.hidden === true || body.hidden === "true" : true;
            const initialState = filesWithChecksums.length > 0 ? "updating" : "ready";

            const [graph] = await db
                .insert(graphTable)
                .values({
                    name: body.name,
                    description: body.description,
                    hidden,
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

            if (filesWithChecksums.length === 0) {
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
                for (const { file, checksum } of filesWithChecksums) {
                    const upload = await putFile(file.name, file, `graphs/${graph.id}`, env.S3_BUCKET);
                    const type: UploadedFile["type"] = (() => {
                        const normalizedMimeType = file.type?.trim().toLowerCase() ?? "";
                        const rawExtension = file.name.split(".").pop()?.trim().toLowerCase();
                        const extension = rawExtension && rawExtension !== file.name.toLowerCase() ? rawExtension : "";

                        if (normalizedMimeType === "application/pdf" || extension === "pdf") {
                            return "pdf";
                        }

                        if (
                            normalizedMimeType === "application/msword" ||
                            normalizedMimeType ===
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
                            extension === "doc" ||
                            extension === "docx"
                        ) {
                            return "doc";
                        }

                        if (
                            normalizedMimeType === "application/vnd.ms-excel" ||
                            normalizedMimeType ===
                                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
                            normalizedMimeType === "text/csv" ||
                            extension === "xls" ||
                            extension === "xlsx" ||
                            extension === "csv"
                        ) {
                            return "sheet";
                        }

                        if (
                            normalizedMimeType === "application/vnd.ms-powerpoint" ||
                            normalizedMimeType ===
                                "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
                            extension === "ppt" ||
                            extension === "pptx"
                        ) {
                            return "ppt";
                        }

                        if (normalizedMimeType.startsWith("image/")) {
                            return "image";
                        }

                        if (normalizedMimeType === "application/json" || extension === "json") {
                            return "json";
                        }

                        return "text";
                    })();

                    uploadedFiles.push({
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
            const existingChecksums = new Set(existingFiles.map((file) => file.checksum).filter((checksum) => checksum !== null));
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

            const uploadedFiles: UploadedFile[] = [];
            try {
                for (const { file, checksum } of filesWithChecksums) {
                    const upload = await putFile(file.name, file, `graphs/${existingGraph.id}`, env.S3_BUCKET);
                    const type: UploadedFile["type"] = (() => {
                        const normalizedMimeType = file.type?.trim().toLowerCase() ?? "";
                        const rawExtension = file.name.split(".").pop()?.trim().toLowerCase();
                        const extension = rawExtension && rawExtension !== file.name.toLowerCase() ? rawExtension : "";

                        if (normalizedMimeType === "application/pdf" || extension === "pdf") {
                            return "pdf";
                        }

                        if (
                            normalizedMimeType === "application/msword" ||
                            normalizedMimeType ===
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
                            extension === "doc" ||
                            extension === "docx"
                        ) {
                            return "doc";
                        }

                        if (
                            normalizedMimeType === "application/vnd.ms-excel" ||
                            normalizedMimeType ===
                                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
                            normalizedMimeType === "text/csv" ||
                            extension === "xls" ||
                            extension === "xlsx" ||
                            extension === "csv"
                        ) {
                            return "sheet";
                        }

                        if (
                            normalizedMimeType === "application/vnd.ms-powerpoint" ||
                            normalizedMimeType ===
                                "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
                            extension === "ppt" ||
                            extension === "pptx"
                        ) {
                            return "ppt";
                        }

                        if (normalizedMimeType.startsWith("image/")) {
                            return "image";
                        }

                        if (normalizedMimeType === "application/json" || extension === "json") {
                            return "json";
                        }

                        return "text";
                    })();

                    uploadedFiles.push({
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
            beforeHandle: requirePermissions({
                graph: ["add:file"],
            }),
        }
    )
    .post(
        "/:id/files/:fileId/retry",
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
            const existingGraph = accessResult.value;

            const [file] = await db
                .select({
                    id: filesTable.id,
                    processStep: filesTable.processStep,
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

            let graph = existingGraph;
            try {
                const [updatedGraph] = await db
                    .update(graphTable)
                    .set({ state: "updating" })
                    .where(eq(graphTable.id, existingGraph.id))
                    .returning(selectGraphFields);

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
                    await db
                        .update(graphTable)
                        .set({ state: existingGraph.state })
                        .where(eq(graphTable.id, existingGraph.id));
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
            beforeHandle: requirePermissions({
                graph: ["delete"],
            }),
        }
    );
