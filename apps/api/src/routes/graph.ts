import { and, asc, eq, inArray, isNotNull, isNull } from "@kiwi/db/drizzle";
import { Elysia, t } from "elysia";
import { auth } from "@kiwi/auth/server";
import type { KiwiPermissions } from "@kiwi/auth/permissions";
import { db } from "@kiwi/db";
import { filesTable, graphTable, groupTable, groupUserTable } from "@kiwi/db/tables/graph";
import { deleteFile, listFiles, putFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { patchGraphFilesSpec } from "@kiwi/worker/patch-graph-files-spec";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import { env } from "../env";
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
type GraphClosureQueryRunner = {
    select: typeof db.select;
};

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

const chunkItems = <T>(items: T[], chunkSize: number) => {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += chunkSize) {
        chunks.push(items.slice(index, index + chunkSize));
    }

    return chunks;
};

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

const getExtension = (name: string) => {
    const extension = name.split(".").pop()?.trim().toLowerCase();
    return extension && extension !== name.toLowerCase() ? extension : "";
};

const normalizeFileType = (name: string, mimeType?: string): GraphFileType => {
    const normalizedMimeType = mimeType?.trim().toLowerCase() ?? "";
    const extension = getExtension(name);

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

const hasPermission = async (headers: Headers, permissions: KiwiPermissions) => {
    const result = await auth.api.userHasPermission({
        headers,
        body: {
            permissions,
        },
    });

    return result.success;
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

    const permitted = await hasPermission(headers, {
        group: ["update"],
    });

    if (!permitted) {
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

const restoreGraphPatchFailure = async (
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
            "failed to rollback graph patch after enqueue failure",
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
            "graph patch rollback left orphaned s3 files",
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

const collectGraphClosure = async (queryRunner: GraphClosureQueryRunner, graphId: string): Promise<string[]> => {
    const graphIds = new Set<string>([graphId]);
    let frontier = [graphId];

    while (frontier.length > 0) {
        const childRows = await queryRunner
            .select({ id: graphTable.id })
            .from(graphTable)
            .where(inArray(graphTable.graphId, frontier));

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
};

const mapGraphErrorResponse = (statusFn: StatusFn) => (error: unknown) => {
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
};

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
                return mapGraphErrorResponse(status)(error);
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
                return mapGraphErrorResponse(status)(error);
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
                return mapGraphErrorResponse(status)(error);
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
                return mapGraphErrorResponse(status)(error);
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
                return mapGraphErrorResponse(status)(error);
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
                return mapGraphErrorResponse(status)(error);
            }

            const files = normalizeFiles(body.files);
            const removedFileIds = normalizeStringList(body.removedFileIds);
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

            const existingFiles = await db
                .select({
                    id: filesTable.id,
                })
                .from(filesTable)
                .where(eq(filesTable.graphId, existingGraph.id));

            const existingFileIds = new Set(existingFiles.map((file) => file.id));
            const hasInvalidRemovedFileIds = removedFileIds.some((fileId) => !existingFileIds.has(fileId));

            if (hasInvalidRemovedFileIds) {
                return status(400, {
                    status: "error",
                    message: "Invalid file IDs",
                    code: INVALID_FILE_IDS,
                });
            }

            const updateData: Partial<Pick<GraphRecord, "name" | "description" | "state">> = {};

            if (normalizedName !== undefined && normalizedName !== existingGraph.name) {
                updateData.name = normalizedName;
            }

            if (normalizedDescription !== undefined && normalizedDescription !== existingGraph.description) {
                updateData.description = normalizedDescription;
            }

            const hasFileChanges = files.length > 0 || removedFileIds.length > 0;
            if (hasFileChanges) {
                updateData.state = "updating";
            }

            if (Object.keys(updateData).length === 0 && !hasFileChanges) {
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
                    "graph patch failed during file upload",
                    "graphId",
                    existingGraph.id,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "removedFileCount",
                    removedFileIds.length,
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

            let patchGraph = existingGraph;
            let addedFiles: CreatedFileRecord[] = [];

            try {
                const patchResult = await db.transaction(async (tx) => {
                    const nextGraph =
                        Object.keys(updateData).length > 0
                            ? (
                                  await tx
                                      .update(graphTable)
                                      .set(updateData)
                                      .where(eq(graphTable.id, existingGraph.id))
                                      .returning(selectGraphFields)
                              )[0]!
                            : existingGraph;

                    const insertedFiles =
                        uploadedFiles.length > 0
                            ? await tx
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
                                  .returning(selectFileFields)
                            : [];

                    return {
                        graph: nextGraph,
                        addedFiles: insertedFiles,
                    };
                });

                patchGraph = patchResult.graph;
                addedFiles = patchResult.addedFiles;
            } catch (dbPatchError) {
                const failedDeletes = await cleanupUploadedKeys(uploadedFiles.map((file) => file.key));

                logError(
                    "graph patch failed during database update",
                    "graphId",
                    existingGraph.id,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "removedFileCount",
                    removedFileIds.length,
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

            if (!hasFileChanges) {
                return status(200, {
                    status: "success",
                    data: {
                        graph: patchGraph,
                        addedFiles: [],
                        removedFileIds: [],
                        workflowRunId: null,
                    },
                });
            }

            try {
                const handle = await ow.runWorkflow(patchGraphFilesSpec, {
                    graphId: existingGraph.id,
                    removedFileIds,
                    addedFileIds: addedFiles.map((file) => file.id),
                });

                return status(200, {
                    status: "success",
                    data: {
                        graph: patchGraph,
                        addedFiles,
                        removedFileIds,
                        workflowRunId: handle.workflowRun.id,
                    },
                });
            } catch (enqueueError) {
                await restoreGraphPatchFailure(
                    existingGraph.id,
                    existingGraph,
                    addedFiles.map((file) => file.id),
                    uploadedFiles.map((file) => file.key)
                );

                logError(
                    "graph patch failed during workflow enqueue",
                    "graphId",
                    existingGraph.id,
                    "uploadedKeyCount",
                    uploadedFiles.length,
                    "addedFileCount",
                    addedFiles.length,
                    "removedFileCount",
                    removedFileIds.length,
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
                name: t.Optional(t.String()),
                description: t.Optional(t.String()),
                files: t.Optional(t.Files()),
                removedFileIds: t.Optional(t.Union([t.String(), t.Array(t.String())])),
            }),
            beforeHandle: requirePermissions({
                graph: ["update"],
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
                return mapGraphErrorResponse(status)(error);
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

                    const graphIds = await collectGraphClosure(tx, params.id);
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
            for (const chunk of chunkItems([...s3Keys], 25)) {
                const deleteResults = await Promise.allSettled(chunk.map((key) => deleteFile(key, env.S3_BUCKET)));

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
