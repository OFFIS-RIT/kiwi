import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { auth } from "@kiwi/auth/server";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { filesTable, graphTable, groupTable, groupUserTable } from "@kiwi/db/tables/graph";
import { deleteFile, getPresignedDownloadUrl, listFiles, putFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { deleteGraphFilesSpec } from "@kiwi/worker/delete-graph-files-spec";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import { env } from "../env";
import { chunk } from "../lib/array";
import { collectGraphClosure } from "../lib/graph";
import { type AuthUser, authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";
import { ow } from "../openworkflow";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";

const INVALID_GRAPH_OWNER = "INVALID_GRAPH_OWNER";
const GROUP_NOT_FOUND = "GROUP_NOT_FOUND";
const GRAPH_NOT_FOUND = "GRAPH_NOT_FOUND";
const FORBIDDEN = "FORBIDDEN";
const INVALID_FILE_IDS = "INVALID_FILE_IDS";
const INVALID_NAME = "INVALID_NAME";
const NO_CHANGES = "NO_CHANGES";

type GraphFileType = "pdf" | "doc" | "sheet" | "ppt" | "image" | "json" | "text";
type GroupAccessResult = { groupId: string };
type RootOwner =
    | {
          mode: "user";
          userId: string;
      }
    | {
          mode: "group";
          groupId: string;
      };
type UploadedFile = {
    name: string;
    size: number;
    type: GraphFileType;
    mimeType: string;
    key: string;
};
type GraphRecord = {
    id: string;
    name: string;
    description: string | null;
    groupId: string | null;
    userId: string | null;
    graphId: string | null;
    hidden: boolean;
    state: "ready" | "updating";
};
type CreatedFileRecord = {
    id: string;
    name: string;
    type: string;
    mimeType: string;
    size: number;
    key: string;
};
type ProjectDetailFileRow = {
    id: string;
    project_id: string;
    name: string;
    file_key: string;
    created_at: Date | null;
    updated_at: Date | null;
};
type ProjectDetailFileRecord = {
    id: string;
    project_id: string;
    name: string;
    file_key: string;
    created_at: string | null;
    updated_at: string | null;
};
type StatusFn = (code: number, body: unknown) => unknown;

const selectGraphFields = {
    id: graphTable.id,
    name: graphTable.name,
    description: graphTable.description,
    groupId: graphTable.groupId,
    userId: graphTable.userId,
    graphId: graphTable.graphId,
    hidden: graphTable.hidden,
    state: graphTable.state,
};

const selectFileFields = {
    id: filesTable.id,
    name: filesTable.name,
    type: filesTable.type,
    mimeType: filesTable.mimeType,
    size: filesTable.size,
    key: filesTable.key,
};

const selectProjectDetailFileFields = {
    id: filesTable.id,
    project_id: filesTable.graphId,
    name: filesTable.name,
    file_key: filesTable.key,
    created_at: filesTable.createdAt,
    updated_at: filesTable.updatedAt,
};

const selectGraphListFields = {
    graph_id: graphTable.id,
    graph_name: graphTable.name,
    graph_state: graphTable.state,
    group_id: graphTable.groupId,
    hidden: graphTable.hidden,
};

const mapProjectDetailFileRecord = (file: ProjectDetailFileRow): ProjectDetailFileRecord => ({
    ...file,
    created_at: file.created_at?.toISOString() ?? null,
    updated_at: file.updated_at?.toISOString() ?? null,
});

const normalizeFiles = (files?: File | File[]) => {
    if (!files) {
        return [];
    }

    return Array.isArray(files) ? files : [files];
};

const normalizeStringList = (value?: string | string[]) => {
    if (!value) {
        return [];
    }

    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values.filter((entry) => entry.length > 0))];
};

const normalizeHidden = (hidden?: boolean | "true" | "false") => {
    if (hidden === undefined) {
        return undefined;
    }

    return hidden === true || hidden === "true";
};

const normalizeFileType = (name: string, mimeType?: string): GraphFileType => {
    const normalizedMimeType = mimeType?.trim().toLowerCase() ?? "";
    const rawExtension = name.split(".").pop()?.trim().toLowerCase();
    const extension = rawExtension && rawExtension !== name.toLowerCase() ? rawExtension : "";

    if (normalizedMimeType === "application/pdf" || extension === "pdf") {
        return "pdf";
    }

    if (
        normalizedMimeType === "application/msword" ||
        normalizedMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        extension === "doc" ||
        extension === "docx"
    ) {
        return "doc";
    }

    if (
        normalizedMimeType === "application/vnd.ms-excel" ||
        normalizedMimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        normalizedMimeType === "text/csv" ||
        extension === "xls" ||
        extension === "xlsx" ||
        extension === "csv"
    ) {
        return "sheet";
    }

    if (
        normalizedMimeType === "application/vnd.ms-powerpoint" ||
        normalizedMimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
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
};

const getGraphById = async (graphId: string): Promise<GraphRecord | null> => {
    const [graph] = await db.select(selectGraphFields).from(graphTable).where(eq(graphTable.id, graphId)).limit(1);
    return graph ?? null;
};

const requireGroupUpdateAccess = async (
    headers: Headers,
    user: AuthUser,
    groupId: string
): Promise<GroupAccessResult> => {
    const [group] = await db.select({ id: groupTable.id }).from(groupTable).where(eq(groupTable.id, groupId)).limit(1);

    if (!group) {
        throw new Error(GROUP_NOT_FOUND);
    }

    if (user.role === "admin") {
        return {
            groupId,
        };
    }

    const [membership] = await db
        .select({
            groupId: groupUserTable.groupId,
        })
        .from(groupUserTable)
        .where(and(eq(groupUserTable.groupId, groupId), eq(groupUserTable.userId, user.id)))
        .limit(1);

    if (!membership) {
        throw new Error(FORBIDDEN);
    }

    const permissionCheck = await auth.api.userHasPermission({
        headers,
        body: {
            permissions: {
                group: ["update"],
            } satisfies KiwiPermissions,
        },
    });

    if (!permissionCheck.success) {
        throw new Error(FORBIDDEN);
    }

    return {
        groupId,
    };
};

const requireGroupViewAccess = async (user: AuthUser, groupId: string): Promise<GroupAccessResult> => {
    const [group] = await db.select({ id: groupTable.id }).from(groupTable).where(eq(groupTable.id, groupId)).limit(1);

    if (!group) {
        throw new Error(GROUP_NOT_FOUND);
    }

    const [membership] = await db
        .select({
            groupId: groupUserTable.groupId,
        })
        .from(groupUserTable)
        .where(and(eq(groupUserTable.groupId, groupId), eq(groupUserTable.userId, user.id)))
        .limit(1);

    if (!membership) {
        throw new Error(FORBIDDEN);
    }

    return {
        groupId,
    };
};

const resolveGraphOwnerRoot = async (parentGraphId: string): Promise<RootOwner> => {
    const visited = new Set<string>();
    let currentGraphId = parentGraphId;
    let isRootLookup = true;

    while (true) {
        if (visited.has(currentGraphId)) {
            throw new Error(INVALID_GRAPH_OWNER);
        }

        visited.add(currentGraphId);

        const graph = await getGraphById(currentGraphId);
        if (!graph) {
            throw new Error(isRootLookup ? GRAPH_NOT_FOUND : INVALID_GRAPH_OWNER);
        }

        if (graph.userId) {
            return {
                mode: "user",
                userId: graph.userId,
            };
        }

        if (graph.groupId) {
            return {
                mode: "group",
                groupId: graph.groupId,
            };
        }

        if (!graph.graphId) {
            throw new Error(INVALID_GRAPH_OWNER);
        }

        currentGraphId = graph.graphId;
        isRootLookup = false;
    }
};

const assertCanCreateUnderParentGraph = async (headers: Headers, user: AuthUser, parentGraphId: string) => {
    if (user.role === "admin") {
        await resolveGraphOwnerRoot(parentGraphId);
        return;
    }

    const rootOwner = await resolveGraphOwnerRoot(parentGraphId);
    if (rootOwner.mode === "user") {
        if (rootOwner.userId !== user.id) {
            throw new Error(FORBIDDEN);
        }
        return;
    }

    await requireGroupUpdateAccess(headers, user, rootOwner.groupId);
};

const assertCanPatchGraph = async (headers: Headers, user: AuthUser, graphId: string): Promise<GraphRecord> => {
    const graph = await getGraphById(graphId);
    if (!graph) {
        throw new Error(GRAPH_NOT_FOUND);
    }

    if (user.role === "admin") {
        return graph;
    }

    const rootOwner = await resolveGraphOwnerRoot(graph.id);
    if (rootOwner.mode === "user") {
        if (rootOwner.userId !== user.id) {
            throw new Error(FORBIDDEN);
        }

        return graph;
    }

    await requireGroupUpdateAccess(headers, user, rootOwner.groupId);
    return graph;
};

export const assertCanViewGraph = async (user: AuthUser, graphId: string): Promise<GraphRecord> => {
    const graph = await getGraphById(graphId);
    if (!graph) {
        throw new Error(GRAPH_NOT_FOUND);
    }

    if (user.role === "admin") {
        return graph;
    }

    const rootOwner = await resolveGraphOwnerRoot(graph.id);
    if (rootOwner.mode === "user") {
        if (rootOwner.userId !== user.id) {
            throw new Error(FORBIDDEN);
        }

        return graph;
    }

    await requireGroupViewAccess(user, rootOwner.groupId);
    return graph;
};

const cleanupUploadedKeys = async (uploadedKeys: string[]) => {
    const deleteResults = await Promise.allSettled(uploadedKeys.map((key) => deleteFile(key, env.S3_BUCKET)));
    return deleteResults.filter((result) => result.status === "rejected").length;
};

const cleanupFailedGraphCreation = async (
    graphId: string,
    uploadedKeys: string[],
    phase: "upload" | "db_insert_files" | "enqueue",
    ownerMode: "group" | "user" | "graph"
) => {
    const failedDeletes = await cleanupUploadedKeys(uploadedKeys);

    try {
        await db.delete(graphTable).where(eq(graphTable.id, graphId));
    } catch (cleanupError) {
        logError(
            "failed to cleanup graph after graph creation error",
            "graphId",
            graphId,
            "ownerMode",
            ownerMode,
            "phase",
            phase,
            "uploadedKeyCount",
            uploadedKeys.length,
            "failedS3CleanupCount",
            failedDeletes,
            "error",
            cleanupError
        );
        return;
    }

    if (failedDeletes > 0) {
        logError(
            "graph creation cleanup left orphaned s3 files",
            "graphId",
            graphId,
            "ownerMode",
            ownerMode,
            "phase",
            phase,
            "uploadedKeyCount",
            uploadedKeys.length,
            "failedS3CleanupCount",
            failedDeletes
        );
    }
};

const restoreGraphFileChangeFailure = async (
    graphId: string,
    previousGraph: GraphRecord,
    addedFileIds: string[],
    uploadedKeys: string[]
) => {
    const failedDeletes = await cleanupUploadedKeys(uploadedKeys);

    try {
        await db.transaction(async (tx) => {
            if (addedFileIds.length > 0) {
                await tx.delete(filesTable).where(inArray(filesTable.id, addedFileIds));
            }

            await tx
                .update(graphTable)
                .set({
                    name: previousGraph.name,
                    description: previousGraph.description,
                    state: previousGraph.state,
                })
                .where(eq(graphTable.id, graphId));
        });
    } catch (cleanupError) {
        logError(
            "failed to rollback graph file change after enqueue failure",
            "graphId",
            graphId,
            "addedFileCount",
            addedFileIds.length,
            "uploadedKeyCount",
            uploadedKeys.length,
            "failedS3CleanupCount",
            failedDeletes,
            "error",
            cleanupError
        );
        return;
    }

    if (failedDeletes > 0) {
        logError(
            "graph file change rollback left orphaned s3 files",
            "graphId",
            graphId,
            "addedFileCount",
            addedFileIds.length,
            "uploadedKeyCount",
            uploadedKeys.length,
            "failedS3CleanupCount",
            failedDeletes
        );
    }
};

function mapGraphError(statusFn: StatusFn, error: unknown) {
    if (!(error instanceof Error)) {
        return statusFn(500, {
            status: "error",
            message: "Internal server error",
            code: "INTERNAL_SERVER_ERROR",
        });
    }

    if (error.message === GROUP_NOT_FOUND) {
        return statusFn(404, {
            status: "error",
            message: "Group not found",
            code: GROUP_NOT_FOUND,
        });
    }

    if (error.message === GRAPH_NOT_FOUND) {
        return statusFn(404, {
            status: "error",
            message: "Graph not found",
            code: GRAPH_NOT_FOUND,
        });
    }

    if (error.message === INVALID_GRAPH_OWNER) {
        return statusFn(400, {
            status: "error",
            message: "Invalid graph owner chain",
            code: INVALID_GRAPH_OWNER,
        });
    }

    if (error.message === FORBIDDEN) {
        return statusFn(403, {
            status: "error",
            message: "Forbidden",
            code: FORBIDDEN,
        });
    }

    return statusFn(500, {
        status: "error",
        message: "Internal server error",
        code: "INTERNAL_SERVER_ERROR",
    });
}

const mapGraphListItem = (graph: {
    graph_id: string;
    graph_name: string;
    graph_state: "ready" | "updating";
    group_id: string | null;
    hidden: boolean;
}) => {
    if (!graph.group_id) {
        throw new Error(INVALID_GRAPH_OWNER);
    }

    return {
        graph_id: graph.graph_id,
        graph_name: graph.graph_name,
        graph_state: graph.graph_state === "updating" ? "update" : "ready",
        group_id: graph.group_id,
        hidden: graph.hidden,
        ...(graph.graph_state === "updating"
            ? {
                  process_percentage: 0,
              }
            : {}),
    };
};

export const graphRoute = new Elysia({ prefix: "/graphs" })
    .use(authMiddleware)
    .get(
        "/",
        async ({ user, status }) => {
            if (!user) {
                return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
            }

            try {
                if (user.role === "admin") {
                    const graphs = await db
                        .select(selectGraphListFields)
                        .from(graphTable)
                        .where(
                            and(isNotNull(graphTable.groupId), isNull(graphTable.graphId), eq(graphTable.hidden, false))
                        )
                        .orderBy(asc(graphTable.groupId), asc(graphTable.name));

                    return status(200, successResponse(graphs.map(mapGraphListItem)));
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

                return status(200, successResponse(graphs.map(mapGraphListItem)));
            } catch (error) {
                return mapGraphError(status, error);
            }
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

            try {
                await assertCanViewGraph(user, params.id);

                const fileRows: ProjectDetailFileRow[] = await db
                    .select(selectProjectDetailFileFields)
                    .from(filesTable)
                    .where(and(eq(filesTable.graphId, params.id), eq(filesTable.deleted, false)))
                    .orderBy(asc(filesTable.createdAt), asc(filesTable.name));

                return status(200, successResponse(fileRows.map(mapProjectDetailFileRecord)));
            } catch (error) {
                return mapGraphError(status, error);
            }
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

            try {
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
            } catch (error) {
                return mapGraphError(status, error);
            }
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

            let graph: GraphRecord;
            try {
                graph = await assertCanViewGraph(user, params.id);
            } catch (error) {
                return mapGraphError(status, error);
            }

            let groupId: string | null = null;
            let groupName: string | null = null;

            try {
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
                        throw new Error(GROUP_NOT_FOUND);
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
                            throw new Error(GROUP_NOT_FOUND);
                        }

                        groupId = group.id;
                        groupName = group.name;
                    }
                }

                const fileRows: ProjectDetailFileRow[] = await db
                    .select(selectProjectDetailFileFields)
                    .from(filesTable)
                    .where(eq(filesTable.graphId, graph.id));
                const files: ProjectDetailFileRecord[] = fileRows.map(mapProjectDetailFileRecord);

                return status(200, {
                    status: "success",
                    data: {
                        project_id: graph.id,
                        project_name: graph.name,
                        project_state: graph.state === "updating" ? "update" : "ready",
                        description: graph.description,
                        hidden: graph.hidden,
                        group_id: groupId,
                        group_name: groupName,
                        files,
                    },
                });
            } catch (error) {
                return mapGraphError(status, error);
            }
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
                    code: INVALID_GRAPH_OWNER,
                });
            }

            const files = normalizeFiles(body.files);
            const ownerMode = body.groupId ? "group" : body.graphId ? "graph" : "user";

            try {
                if (body.groupId) {
                    await requireGroupUpdateAccess(request.headers, user, body.groupId);
                } else if (body.graphId) {
                    await assertCanCreateUnderParentGraph(request.headers, user, body.graphId);
                }
            } catch (error) {
                return mapGraphError(status, error);
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

            let existingGraph: GraphRecord;
            try {
                existingGraph = await assertCanPatchGraph(request.headers, user, params.id);
            } catch (error) {
                return mapGraphError(status, error);
            }

            const normalizedName = body.name === undefined ? undefined : body.name.trim();
            const normalizedDescription =
                body.description === undefined ? undefined : body.description === "" ? null : body.description;

            if (normalizedName !== undefined && normalizedName.length === 0) {
                return status(400, {
                    status: "error",
                    message: "Invalid name",
                    code: INVALID_NAME,
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
                    code: NO_CHANGES,
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

            let existingGraph: GraphRecord;
            try {
                existingGraph = await assertCanPatchGraph(request.headers, user, params.id);
            } catch (error) {
                return mapGraphError(status, error);
            }

            const files = normalizeFiles(body.files);
            if (files.length === 0) {
                return status(400, {
                    status: "error",
                    message: "No changes requested",
                    code: NO_CHANGES,
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

            let existingGraph: GraphRecord;
            try {
                existingGraph = await assertCanPatchGraph(request.headers, user, params.id);
            } catch (error) {
                return mapGraphError(status, error);
            }

            const fileKeys = normalizeStringList(body.fileKeys);
            if (fileKeys.length === 0) {
                return status(400, {
                    status: "error",
                    message: "No changes requested",
                    code: NO_CHANGES,
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
                    code: INVALID_FILE_IDS,
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

            try {
                await assertCanPatchGraph(request.headers, user, params.id);
            } catch (error) {
                return mapGraphError(status, error);
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

            try {
                deleteResult = await db.transaction(async (tx) => {
                    const [graph] = await tx
                        .select({ id: graphTable.id })
                        .from(graphTable)
                        .where(eq(graphTable.id, params.id))
                        .limit(1);

                    if (!graph) {
                        throw new Error(GRAPH_NOT_FOUND);
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
                });
            } catch (error) {
                if (error instanceof Error && error.message === GRAPH_NOT_FOUND) {
                    return status(404, {
                        status: "error",
                        message: "Graph not found",
                        code: GRAPH_NOT_FOUND,
                    });
                }

                return status(500, {
                    status: "error",
                    message: "Internal server error",
                    code: "INTERNAL_SERVER_ERROR",
                });
            }

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
