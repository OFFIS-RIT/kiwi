import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { ulid } from "ulid";
import { tryDb, tryDbVoid, type Database } from "@kiwi/db/effect";
import { filesTable, graphTable, processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import { putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import type { GraphCreateFields } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES, internalServerError, makeApiError } from "@kiwi/contracts/errors";
import { env } from "../../env";
import { expandArchiveUploadFiles } from "../../lib/archive-upload";
import {
    assertCanCreateTeamGraph,
    assertCanCreateTopLevelGraph,
    assertCanCreateUnderParentGraph,
    selectGraphFields,
} from "../../lib/graph/access";
import {
    assertConfiguredUploadModels,
    cleanupUploadedKeys,
    inferSupportedUploadedFiles,
    selectFileFields,
    uniqueFilesByChecksum,
    type UploadedFile,
} from "../../lib/graph/route";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";
import { toApiError } from "../_shared/api-effect";
import { archiveUploadError, getGraphOwnerModelOrganizationId, unsupportedUploadError, type NewGraphOwner } from "./upload-helpers";

function resolveNewGraphOwner(user: AuthUser, fields: GraphCreateFields): Effect.Effect<NewGraphOwner, unknown, Database> {
    return Effect.gen(function* () {
        if (fields.teamId) {
            const access = yield* assertCanCreateTeamGraph(user, fields.teamId);
            return { ownerMode: "team", organizationId: access.team.organizationId, teamId: fields.teamId };
        }

        if (fields.graphId) {
            yield* assertCanCreateUnderParentGraph(user, fields.graphId);
            return { ownerMode: "graph", graphId: fields.graphId };
        }

        const access = yield* assertCanCreateTopLevelGraph(user);
        return { ownerMode: "organization", organizationId: access.organizationId };
    });
}

function cleanupFailedGraphCreation(
    graphId: string,
    uploadedKeys: string[],
    phase: "upload" | "db_insert_files" | "enqueue",
    ownerMode: NewGraphOwner["ownerMode"]
): Effect.Effect<void, unknown, Database> {
    return Effect.gen(function* () {
        const failedDeletes = yield* cleanupUploadedKeys(uploadedKeys);

        const cleanupResult = yield* Effect.match(
            tryDbVoid((db) => db.delete(graphTable).where(eq(graphTable.id, graphId))),
            {
                onFailure: (cleanupError) => ({ ok: false as const, cleanupError }),
                onSuccess: () => ({ ok: true as const }),
            }
        );

        if (!cleanupResult.ok) {
            logError("failed to cleanup graph after graph creation error", {
                graphId,
                ownerMode,
                phase,
                uploadedKeyCount: uploadedKeys.length,
                failedS3CleanupCount: failedDeletes,
                error: cleanupResult.cleanupError,
            });
            return;
        }

        if (failedDeletes > 0) {
            logError("graph creation cleanup left orphaned s3 files", {
                graphId,
                ownerMode,
                phase,
                uploadedKeyCount: uploadedKeys.length,
                failedS3CleanupCount: failedDeletes,
            });
        }
    });
}

export function createGraph(input: { user: AuthUser; fields: GraphCreateFields; files: File[] }) {
    return Effect.mapError(Effect.catchDefect(Effect.gen(function* () {
        if (input.fields.teamId && input.fields.graphId) {
            return yield* Effect.fail(
                makeApiError(400, API_ERROR_CODES.INVALID_GRAPH_OWNER, "Only one owner may be specified")
            );
        }

        const owner = yield* resolveNewGraphOwner(input.user, input.fields);
        const expanded = yield* expandArchiveUploadFiles(input.files);
        if (!expanded.ok) {
            return yield* Effect.fail(archiveUploadError(expanded));
        }

        const filesWithChecksums = yield* uniqueFilesByChecksum(expanded.files);
        const supportedUpload = inferSupportedUploadedFiles(filesWithChecksums);
        if (!supportedUpload.ok) {
            return yield* Effect.fail(unsupportedUploadError(supportedUpload));
        }

        const organizationId = yield* getGraphOwnerModelOrganizationId(owner);
        yield* assertConfiguredUploadModels({
            organizationId,
            files: supportedUpload.files,
            secret: env.AUTH_SECRET,
        });

        const hidden = owner.ownerMode === "graph" ? true : input.fields.hidden === true || input.fields.hidden === "true";
        const initialState = supportedUpload.files.length > 0 ? "updating" : "ready";
        const [graph] = yield* tryDb((db) =>
            db
                .insert(graphTable)
                .values({
                    name: input.fields.name,
                    description: input.fields.description,
                    hidden,
                    state: initialState,
                    organizationId: owner.ownerMode === "graph" ? undefined : owner.organizationId,
                    teamId: owner.ownerMode === "team" ? owner.teamId : undefined,
                    graphId: owner.ownerMode === "graph" ? owner.graphId : undefined,
                })
                .returning(selectGraphFields)
        );

        if (!graph) {
            return yield* Effect.fail(internalServerError());
        }

        if (supportedUpload.files.length === 0) {
            return { graph, files: [], workflowRunId: null };
        }

        const uploadedFiles: UploadedFile[] = [];
        yield* Effect.matchEffect(
            Effect.catchDefect(Effect.gen(function* () {
                for (const { file, checksum, type } of supportedUpload.files) {
                    const fileId = ulid();
                    const upload = yield* putGraphFile(graph.id, fileId, file.name, file, env.S3_BUCKET);
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
            }), (defect) => Effect.fail(defect)),
            {
                onFailure: (uploadError) =>
                    Effect.gen(function* () {
                        yield* cleanupFailedGraphCreation(
                            graph.id,
                            uploadedFiles.map((file) => file.key),
                            "upload",
                            owner.ownerMode
                        );
                        logError("graph creation failed during file upload", {
                            graphId: graph.id,
                            ownerMode: owner.ownerMode,
                            uploadedKeyCount: uploadedFiles.length,
                            error: uploadError,
                        });
                        return yield* Effect.fail(internalServerError());
                    }),
                onSuccess: Effect.succeed,
            }
        );

        const createdFiles = yield* Effect.matchEffect(
            tryDb((db) =>
                db
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
                    .returning(selectFileFields)
            ),
            {
                onFailure: (dbInsertError) =>
                    Effect.gen(function* () {
                        yield* cleanupFailedGraphCreation(
                            graph.id,
                            uploadedFiles.map((file) => file.key),
                            "db_insert_files",
                            owner.ownerMode
                        );
                        logError("graph creation failed during file row insert", {
                            graphId: graph.id,
                            ownerMode: owner.ownerMode,
                            uploadedKeyCount: uploadedFiles.length,
                            error: dbInsertError,
                        });
                        return yield* Effect.fail(internalServerError());
                    }),
                onSuccess: Effect.succeed,
            }
        );

        return yield* Effect.matchEffect(
            Effect.catchDefect(Effect.gen(function* () {
                const [processRun] = yield* tryDb((db) =>
                    db
                        .insert(processRunsTable)
                        .values({ graphId: graph.id, status: "pending" })
                        .returning({ id: processRunsTable.id })
                );
                if (!processRun) {
                    return yield* Effect.fail(new Error("Failed to create process run"));
                }

                yield* tryDbVoid((db) =>
                    db.insert(processRunFilesTable).values(
                        createdFiles.map((file) => ({
                            processRunId: processRun.id,
                            fileId: file.id,
                        }))
                    )
                );

                const handle = yield* Effect.tryPromise({
                    try: () =>
                        ow.runWorkflow(processFilesSpec, {
                            graphId: graph.id,
                            fileIds: createdFiles.map((file) => file.id),
                            processRunId: processRun.id,
                        }),
                    catch: (error) => error,
                });

                return { graph, files: createdFiles, workflowRunId: handle.workflowRun.id };
            }), (defect) => Effect.fail(defect)),
            {
                onFailure: (enqueueError) =>
                    Effect.gen(function* () {
                        yield* cleanupFailedGraphCreation(
                            graph.id,
                            uploadedFiles.map((file) => file.key),
                            "enqueue",
                            owner.ownerMode
                        );
                        logError("graph creation failed during workflow enqueue", {
                            graphId: graph.id,
                            ownerMode: owner.ownerMode,
                            uploadedKeyCount: uploadedFiles.length,
                            error: enqueueError,
                        });
                        return yield* Effect.fail(internalServerError());
                    }),
                onSuccess: Effect.succeed,
            }
        );
    }), (defect) => Effect.fail(defect)), toApiError);
}
