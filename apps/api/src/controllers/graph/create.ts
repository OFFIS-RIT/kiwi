import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { ulid } from "ulid";
import { db } from "@kiwi/db";
import { filesTable, graphTable, processRunFilesTable, processRunsTable } from "@kiwi/db/tables/graph";
import { putGraphFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { processFilesSpec } from "@kiwi/worker/process-files-spec";
import type { GraphCreateFields, GraphCreateSuccessData } from "@kiwi/contracts/graphs";
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
    type CreatedFileRecord,
    type UploadedFile,
} from "../../lib/graph/route";
import type { AuthUser } from "../../middleware/auth";
import { ow } from "../../openworkflow";
import { tryApiPromise } from "../_shared/api-effect";
import { archiveUploadError, getGraphOwnerModelOrganizationId, unsupportedUploadError, type NewGraphOwner } from "./upload-helpers";

async function resolveNewGraphOwner(user: AuthUser, fields: GraphCreateFields): Promise<NewGraphOwner> {
    if (fields.teamId) {
        const access = await assertCanCreateTeamGraph(user, fields.teamId);
        return { ownerMode: "team", organizationId: access.team.organizationId, teamId: fields.teamId };
    }

    if (fields.graphId) {
        await assertCanCreateUnderParentGraph(user, fields.graphId);
        return { ownerMode: "graph", graphId: fields.graphId };
    }

    const access = await assertCanCreateTopLevelGraph(user);
    return { ownerMode: "organization", organizationId: access.organizationId };
}

async function cleanupFailedGraphCreation(
    graphId: string,
    uploadedKeys: string[],
    phase: "upload" | "db_insert_files" | "enqueue",
    ownerMode: NewGraphOwner["ownerMode"]
) {
    const failedDeletes = await cleanupUploadedKeys(uploadedKeys);

    try {
        await db.delete(graphTable).where(eq(graphTable.id, graphId));
    } catch (cleanupError) {
        logError("failed to cleanup graph after graph creation error", {
            graphId,
            ownerMode,
            phase,
            uploadedKeyCount: uploadedKeys.length,
            failedS3CleanupCount: failedDeletes,
            error: cleanupError,
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
}

export function createGraph(input: { user: AuthUser; fields: GraphCreateFields; files: File[] }) {
    return tryApiPromise(async (): Promise<GraphCreateSuccessData> => {
        if (input.fields.teamId && input.fields.graphId) {
            throw makeApiError(400, API_ERROR_CODES.INVALID_GRAPH_OWNER, "Only one owner may be specified");
        }

        const owner = await resolveNewGraphOwner(input.user, input.fields);
        const expanded = await expandArchiveUploadFiles(input.files);
        if (!expanded.ok) {
            throw archiveUploadError(expanded);
        }

        const filesWithChecksums = await uniqueFilesByChecksum(expanded.files);
        const supportedUpload = inferSupportedUploadedFiles(filesWithChecksums);
        if (!supportedUpload.ok) {
            throw unsupportedUploadError(supportedUpload);
        }

        await assertConfiguredUploadModels({
            organizationId: await Effect.runPromise(getGraphOwnerModelOrganizationId(owner)),
            files: supportedUpload.files,
            secret: env.AUTH_SECRET,
        });

        const hidden = owner.ownerMode === "graph" ? true : input.fields.hidden === true || input.fields.hidden === "true";
        const initialState = supportedUpload.files.length > 0 ? "updating" : "ready";
        const [graph] = await db
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
            .returning(selectGraphFields);

        if (!graph) {
            throw internalServerError();
        }

        if (supportedUpload.files.length === 0) {
            return { graph, files: [], workflowRunId: null };
        }

        const uploadedFiles: UploadedFile[] = [];
        try {
            for (const { file, checksum, type } of supportedUpload.files) {
                const fileId = ulid();
                const upload = await Effect.runPromise(putGraphFile(graph.id, fileId, file.name, file, env.S3_BUCKET));
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
                owner.ownerMode
            );
            logError("graph creation failed during file upload", {
                graphId: graph.id,
                ownerMode: owner.ownerMode,
                uploadedKeyCount: uploadedFiles.length,
                error: uploadError,
            });
            throw internalServerError();
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
                owner.ownerMode
            );
            logError("graph creation failed during file row insert", {
                graphId: graph.id,
                ownerMode: owner.ownerMode,
                uploadedKeyCount: uploadedFiles.length,
                error: dbInsertError,
            });
            throw internalServerError();
        }

        try {
            const [processRun] = await db
                .insert(processRunsTable)
                .values({ graphId: graph.id, status: "pending" })
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

            return { graph, files: createdFiles, workflowRunId: handle.workflowRun.id };
        } catch (enqueueError) {
            await cleanupFailedGraphCreation(
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
            throw internalServerError();
        }
    });
}
