import { db } from "@kiwi/db";
import { filesTable, graphTable, processRunsTable, processStatsTable } from "@kiwi/db/tables/graph";
import { and, eq, inArray, sql } from "drizzle-orm";
import { defineWorkflow } from "openworkflow";
import z from "zod";
import { S3Loader } from "@kiwi/graph/loader/s3";
import { createGraphChunker } from "@kiwi/graph/chunker/factory";
import { env } from "../env";
import type { Graph, GraphFile, LoadedGraphDocument, Unit } from "@kiwi/graph";
import { dedupe } from "@kiwi/graph/dedupe";
import { coerceGraphFileType } from "@kiwi/graph/file-type";
import type { GraphFileType } from "@kiwi/graph/file-type";
import { loadGraphDocument } from "@kiwi/graph/loader/document";
import { createDetectedGraphLoader, detectGraphLoaderFileFormat } from "@kiwi/graph/loader/factory";
import { mergeGraphs } from "@kiwi/graph/merge";
import { createUnitsFromText, processUnit } from "@kiwi/graph/unit";
import { estimateToken } from "@kiwi/ai";
import { resolveGraphModelOrganizationId } from "@kiwi/ai/models";
import { getFile, putNamedFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { createWorkerClient } from "../lib/ai";
import { chunkItems } from "../lib/chunk";
import { processFilesSpec } from "./process-files-spec";
import { deleteGraphFileProcessingArtifacts, getGraphFileArtifactPaths } from "../lib/derived-files";
import { buildMetadata, buildMetadataExcerpt } from "../lib/metadata";
import { updateDescriptionsSpec } from "./update-descriptions-spec";
import { DESCRIPTION_BATCH_SIZE } from "../lib/description-workflow";
import { getFileTypeProcessingConfig } from "../lib/file-type-config";
import { requireReadableContentText } from "../lib/readable-text";
import { classifyFileProcessError } from "../lib/file-process-error";
import { collectPendingDescriptionTargets, saveGraphToDatabase } from "../lib/save-graph";
import { prepareCodeManifest } from "../lib/code-manifest";
import { invalidateSupersededRepositorySources } from "../lib/code-repository-finalizer";
import { updateFileProcessingState, stopIfFileDeleted } from "../lib/file-processing-state";
import { processCodeFile } from "./process-code-file";

const FILE_DELETED = "__file_deleted__" as const;
const NO_RETRY = { maximumAttempts: 1 } as const;
const PROCESS_UNIT_BATCH_SIZE = 100;

function workflowError(error: unknown) {
    if (error instanceof Error) {
        return new Error(error.message, { cause: error });
    }

    return new Error("Workflow failed", { cause: error });
}

export function fileProcessingWorkflow(
    graphId: string,
    fileId: string,
    fileType: GraphFileType | undefined,
    codeManifestKey?: string
) {
    return fileType === "code"
        ? {
              spec: processCodeFile.spec,
              input: {
                  graphId,
                  fileId,
                  ...(codeManifestKey ? { codeManifestKey } : {}),
              },
          }
        : {
              spec: processFile.spec,
              input: {
                  graphId,
                  fileId,
              },
          };
}

export function shouldAbortRepositoryBatch(
    code: { kind: "repository"; retiredFileIds?: string[] } | undefined,
    results: PromiseSettledResult<unknown>[]
) {
    return code?.kind === "repository" && code.retiredFileIds !== undefined && results.some((result) => result.status === "rejected");
}

export function shouldFinalizeRepositoryBatch(
    code: { kind: "repository"; retiredFileIds?: string[] } | undefined,
    results: PromiseSettledResult<unknown>[]
) {
    return (
        code?.kind === "repository" &&
        results.every((result) => result.status === "fulfilled") &&
        (results.length > 0 || (code.retiredFileIds?.length ?? 0) > 0)
    );
}

export const processFiles = defineWorkflow(processFilesSpec, async ({ input, step, run }) => {
    try {
        await step.run({ name: "mark-files-pending" }, async () => {
            if (input.fileIds.length === 0) {
                return;
            }

            await db
                .update(filesTable)
                .set({
                    processStep: "pending",
                    status: "processing",
                    processErrorCode: null,
                })
                .where(and(eq(filesTable.graphId, input.graphId), inArray(filesTable.id, input.fileIds)));
        });

        // Update project status
        await step.run({ name: "update-project-status" }, async () => {
            await db.update(graphTable).set({ state: "updating" }).where(eq(graphTable.id, input.graphId));

            if (input.processRunId) {
                await db
                    .update(processRunsTable)
                    .set({ status: "started", startedAt: sql`NOW()` })
                    .where(eq(processRunsTable.id, input.processRunId));
            }
        });

        const fileTypeRows = await step.run({ name: "load-file-types" }, async () => {
            if (input.fileIds.length === 0) {
                return [];
            }

            return db
                .select({
                    id: filesTable.id,
                    type: filesTable.type,
                })
                .from(filesTable)
                .where(and(eq(filesTable.graphId, input.graphId), inArray(filesTable.id, input.fileIds)));
        });
        const fileTypes = new Map(fileTypeRows.map((file) => [file.id, coerceGraphFileType(file.type)]));
        const hasCodeFiles = [...fileTypes.values()].some((type) => type === "code");

        const codeManifestKey =
            input.code && hasCodeFiles
                ? await step.run({ name: "prepare-code-manifest" }, async () =>
                      prepareCodeManifest({
                          graphId: input.graphId,
                          fileIds: input.fileIds.filter((fileId) => fileTypes.get(fileId) === "code"),
                          processRunId: input.processRunId,
                      })
                  )
                : undefined;

        const fileResults = await Promise.allSettled(
            input.fileIds.map((fileId) => {
                const workflow = fileProcessingWorkflow(input.graphId, fileId, fileTypes.get(fileId), codeManifestKey);
                return step.runWorkflow(workflow.spec, workflow.input);
            })
        );
        if (fileResults.length > 0 && fileResults.every((result) => result.status === "rejected")) {
            throw new Error(`All ${fileResults.length} file processing workflows failed`);
        }
        if (shouldAbortRepositoryBatch(input.code, fileResults)) {
            throw new Error(
                `${fileResults.filter((result) => result.status === "rejected").length} repository file processing workflows failed`
            );
        }

        if (shouldFinalizeRepositoryBatch(input.code, fileResults)) {
            const invalidated = await step.run({ name: "finalize-repository-snapshot" }, async () =>
                invalidateSupersededRepositorySources(
                    input.code?.retiredFileIds !== undefined
                        ? {
                              graphId: input.graphId,
                              retiredFileIds: input.code.retiredFileIds,
                          }
                        : {
                              graphId: input.graphId,
                              latestFileIds: input.fileIds.filter((fileId) => fileTypes.get(fileId) === "code"),
                          }
                )
            );

            await Promise.all([
                ...chunkItems(invalidated.entityIds, DESCRIPTION_BATCH_SIZE).map((entityIds) =>
                    step.runWorkflow(updateDescriptionsSpec, {
                        graphId: input.graphId,
                        entityIds,
                    })
                ),
                ...chunkItems(invalidated.relationshipIds, DESCRIPTION_BATCH_SIZE).map((relationshipIds) =>
                    step.runWorkflow(updateDescriptionsSpec, {
                        graphId: input.graphId,
                        relationshipIds,
                    })
                ),
            ]);
        }

        const descriptions = await step.run({ name: "generate-descriptions" }, async () => {
            return collectPendingDescriptionTargets(input.graphId);
        });

        await Promise.all([
            ...chunkItems(descriptions.entityIds, DESCRIPTION_BATCH_SIZE).map((entityIds) =>
                step.runWorkflow(updateDescriptionsSpec, {
                    graphId: input.graphId,
                    entityIds,
                })
            ),
            ...chunkItems(descriptions.relationshipIds, DESCRIPTION_BATCH_SIZE).map((relationshipIds) =>
                step.runWorkflow(updateDescriptionsSpec, {
                    graphId: input.graphId,
                    relationshipIds,
                })
            ),
        ]);

        await step.run({ name: "finalize-project-status" }, async () => {
            await db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId));

            if (input.processRunId) {
                await db
                    .update(processRunsTable)
                    .set({ status: "completed", completedAt: sql`NOW()` })
                    .where(eq(processRunsTable.id, input.processRunId));
            }
        });
    } catch (error) {
        if (run.retryTerminal) {
            await step.run({ name: "mark-project-failed", retryPolicy: NO_RETRY }, async () => {
                await db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId));

                if (input.processRunId) {
                    await db
                        .update(processRunsTable)
                        .set({ status: "failed", completedAt: sql`NOW()` })
                        .where(eq(processRunsTable.id, input.processRunId));
                }
            });
        }

        throw workflowError(error);
    }
});

export const processFile = defineWorkflow(
    {
        name: "process-file",
        version: "1.0.0",
        retryPolicy: {
            initialInterval: "1s",
            backoffCoefficient: 2,
            maximumInterval: "30s",
            maximumAttempts: 3,
        },
        schema: z.object({
            graphId: z.string(),
            fileId: z.string(),
        }),
    },
    async ({ input, step, run }) => {
        try {
            let fileData;
            [fileData] = await step.run({ name: "get-file-data" }, async () => {
                return db
                    .select()
                    .from(filesTable)
                    .where(and(eq(filesTable.graphId, input.graphId), eq(filesTable.id, input.fileId)))
                    .limit(1);
            });

            if (!fileData) {
                return;
            }

            if (fileData.deleted) {
                await updateFileProcessingState(input.fileId, "completed", "processed");
                return;
            }

            const paths = getGraphFileArtifactPaths({
                graphId: input.graphId,
                fileId: input.fileId,
                fileKey: fileData.key,
            });

            const baseFile = await step.run({ name: "preprocess-file" }, async () => {
                if (await stopIfFileDeleted(input.fileId)) {
                    return FILE_DELETED;
                }

                await updateFileProcessingState(input.fileId, "preprocessing", "processing");
                const start = performance.now();
                const client = await createWorkerClient(input.graphId);
                const s3Loader = new S3Loader(fileData.key, env.S3_BUCKET);
                const fileContent = await s3Loader.getBinary();
                const declaredType = coerceGraphFileType(fileData.type);
                const derivedImageStorage = {
                    bucket: env.S3_BUCKET,
                    imagePrefix: paths.derivedImagePrefix,
                };
                const detectedFormat = detectGraphLoaderFileFormat({
                    content: fileContent,
                    declaredType,
                    mimeType: fileData.mimeType,
                    audioModel: client.audio,
                    videoModel: client.video,
                });
                const organizationId = await resolveGraphModelOrganizationId(input.graphId);
                const typeConfig = await getFileTypeProcessingConfig(organizationId, detectedFormat.fileType);
                const { loader } = createDetectedGraphLoader({
                    content: fileContent,
                    declaredType,
                    mimeType: fileData.mimeType,
                    format: detectedFormat,
                    documentMode: typeConfig.documentMode ?? undefined,
                    imageModel: client.image,
                    audioModel: client.audio,
                    videoModel: client.video,
                    derivedImageStorage,
                });
                const baseGraphFile = {
                    id: input.fileId,
                    key: fileData.key,
                    filename: fileData.name,
                    filetype: detectedFormat.fileType,
                } satisfies Omit<GraphFile, "loader" | "chunker">;

                if (detectedFormat.fileType !== fileData.type || detectedFormat.mimeType !== fileData.mimeType) {
                    await db
                        .update(filesTable)
                        .set({
                            type: detectedFormat.fileType,
                            mimeType: detectedFormat.mimeType,
                        })
                        .where(eq(filesTable.id, input.fileId));

                    fileData.type = detectedFormat.fileType;
                    fileData.mimeType = detectedFormat.mimeType;
                }

                const graphFile = {
                    ...baseGraphFile,
                    loader,
                } satisfies Omit<GraphFile, "chunker">;
                const document = await loadGraphDocument(graphFile.loader);
                const contentText = requireReadableContentText(document.text);
                const tokens = estimateToken(contentText);
                const uploadedDocument = await putNamedFile(
                    "document.json",
                    JSON.stringify(document),
                    paths.processingPrefix,
                    env.S3_BUCKET
                );

                const duration = performance.now() - start;

                await db
                    .update(filesTable)
                    .set({
                        tokenCount: tokens,
                        loader: detectedFormat.loaderKind,
                        documentMode: typeConfig.documentMode,
                    })
                    .where(eq(filesTable.id, input.fileId));

                return {
                    ...baseGraphFile,
                    documentKey: uploadedDocument.key,
                    duration,
                    tokenCount: tokens,
                    metadataExcerpt: buildMetadataExcerpt(contentText),
                };
            });
            if (baseFile === FILE_DELETED) {
                return;
            }

            const metadataResult = await step.run({ name: "metadata" }, async () => {
                if (await stopIfFileDeleted(input.fileId)) {
                    return FILE_DELETED;
                }

                await updateFileProcessingState(input.fileId, "metadata", "processing");
                const client = await createWorkerClient(input.graphId);
                const metadata = await buildMetadata(client.text, fileData.name, baseFile.metadataExcerpt);

                await db
                    .update(filesTable)
                    .set({ metadata: metadata || null })
                    .where(eq(filesTable.id, input.fileId));

                return {
                    metadata,
                };
            });
            if (metadataResult === FILE_DELETED) {
                return;
            }

            const unitsResult = await step.run({ name: "build-units" }, async () => {
                if (await stopIfFileDeleted(input.fileId)) {
                    return FILE_DELETED;
                }

                await updateFileProcessingState(input.fileId, "chunking", "processing");
                const start = performance.now();

                const organizationId = await resolveGraphModelOrganizationId(input.graphId);
                const typeConfig = await getFileTypeProcessingConfig(
                    organizationId,
                    coerceGraphFileType(baseFile.filetype)
                );
                const chunker = createGraphChunker(typeConfig.chunker, typeConfig.chunkSize);

                await db
                    .update(filesTable)
                    .set({
                        chunker: typeConfig.chunker,
                        chunkSize: typeConfig.chunkSize,
                    })
                    .where(eq(filesTable.id, input.fileId));

                const loadedDocument = await getFile<LoadedGraphDocument>(baseFile.documentKey, env.S3_BUCKET, "json");
                if (!loadedDocument) {
                    throw new Error(`Failed to load document from ${baseFile.documentKey}`);
                }

                const units = await createUnitsFromText({
                    fileId: baseFile.id,
                    fileType: baseFile.filetype,
                    text: loadedDocument.content.text,
                    chunker,
                    loaderSourceChunks: loadedDocument.content.sourceChunks,
                });
                const uploadedUnits = await putNamedFile(
                    "units.json",
                    JSON.stringify(units),
                    paths.processingPrefix,
                    env.S3_BUCKET
                );

                const duration = performance.now() - start;

                return {
                    unitsKey: uploadedUnits.key,
                    duration,
                };
            });
            if (unitsResult === FILE_DELETED) {
                return;
            }

            const graphResult = await step.run({ name: "build-graph" }, async () => {
                if (await stopIfFileDeleted(input.fileId)) {
                    return FILE_DELETED;
                }

                await updateFileProcessingState(input.fileId, "extracting", "processing");
                const start = performance.now();
                const client = await createWorkerClient(input.graphId);

                const loadedUnits = await getFile<Unit[]>(unitsResult.unitsKey, env.S3_BUCKET, "json");
                if (!loadedUnits) {
                    throw new Error(`Failed to load units from ${unitsResult.unitsKey}`);
                }

                const graphs: Graph[] = [];
                for (const units of chunkItems(loadedUnits.content, PROCESS_UNIT_BATCH_SIZE)) {
                    graphs.push(
                        ...(await Promise.all(
                            units.map((unit) =>
                                processUnit(unit, client.text, fileData.name, metadataResult.metadata || undefined)
                            )
                        ))
                    );
                }
                const mergedGraph = mergeGraphs(graphs);
                const graph = dedupe(mergedGraph);
                const uploadedGraph = await putNamedFile(
                    "graph.json",
                    JSON.stringify(graph),
                    paths.processingPrefix,
                    env.S3_BUCKET
                );

                const duration = performance.now() - start;

                return {
                    graphKey: uploadedGraph.key,
                    duration,
                };
            });
            if (graphResult === FILE_DELETED) {
                return;
            }

            const saveGraphResult = await step.run({ name: "save-graph" }, async () => {
                if (await stopIfFileDeleted(input.fileId)) {
                    return FILE_DELETED;
                }

                await updateFileProcessingState(input.fileId, "deduplicating", "processing");

                await updateFileProcessingState(input.fileId, "saving", "processing");

                const loadedGraph = await getFile<Graph>(graphResult.graphKey, env.S3_BUCKET, "json");
                if (!loadedGraph) {
                    throw new Error(`Failed to load graph from ${graphResult.graphKey}`);
                }

                const graph = loadedGraph.content;
                const saveResult = await saveGraphToDatabase(input.graphId, graph);

                return {
                    summary: {
                        fileId: input.fileId,
                        ...saveResult.summary,
                    },
                    duration: saveResult.duration,
                    metrics: saveResult.metrics,
                };
            });
            if (saveGraphResult === FILE_DELETED) {
                return;
            }

            const statsResult = await step.run({ name: "store-process-stats" }, async () => {
                if (await stopIfFileDeleted(input.fileId)) {
                    return FILE_DELETED;
                }

                try {
                    const totalTime =
                        baseFile.duration + unitsResult.duration + graphResult.duration + saveGraphResult.duration;

                    await db.insert(processStatsTable).values({
                        totalTime,
                        files: 1,
                        fileSizes: fileData.size,
                        fileType: baseFile.filetype,
                        tokenCount: baseFile.tokenCount,
                    });
                } catch (error) {
                    logError("failed to store file process stats", {
                        graphId: input.graphId,
                        fileId: input.fileId,
                        error,
                    });
                }
            });
            if (statsResult === FILE_DELETED) {
                return;
            }

            await step.run({ name: "mark-file-complete" }, async () => {
                await updateFileProcessingState(input.fileId, "completed", "processed");
            });

            await step.run({ name: "cleanup-processing-artifacts" }, async () => {
                try {
                    return await deleteGraphFileProcessingArtifacts({
                        graphId: input.graphId,
                        fileId: input.fileId,
                        fileKey: fileData.key,
                        bucket: env.S3_BUCKET,
                    });
                } catch (error) {
                    logError("failed to cleanup processing artifacts", {
                        graphId: input.graphId,
                        fileId: input.fileId,
                        error,
                    });
                    return { deletedKeyCount: 0 };
                }
            });

            return saveGraphResult.summary;
        } catch (error) {
            if (run.retryTerminal) {
                await updateFileProcessingState(input.fileId, "failed", "failed", classifyFileProcessError(error));
            } else {
                await updateFileProcessingState(input.fileId, "pending", "processing", null);
            }

            throw workflowError(error);
        }
    }
);
