import * as Effect from "effect/Effect";
import { withWorkerDb, withWorkerDbVoid } from "../lib/runtime/effect";
import { filesTable, graphTable, processRunsTable, processStatsTable } from "@kiwi/db/tables/graph";
import { and, eq, inArray, sql } from "@kiwi/db/drizzle";
import { defineWorkflow } from "openworkflow";
import { S3Loader } from "@kiwi/loaders/loader/s3";
import { createGraphChunker } from "@kiwi/loaders/chunker/factory";
import { env } from "../env";
import type { Graph, GraphFile, LoadedGraphDocument, Unit } from "@kiwi/graph";
import { dedupe } from "@kiwi/graph/dedupe";
import { coerceGraphFileType } from "@kiwi/graph/file-type";
import { loadGraphDocument } from "@kiwi/loaders/loader/document";
import { createDetectedGraphLoader, detectGraphLoaderFileFormat } from "@kiwi/loaders/loader/factory";
import { mergeGraphs } from "@kiwi/graph/merge";
import { createUnitsFromText, processUnit } from "@kiwi/graph/unit";
import { estimateToken } from "@kiwi/ai";
import { resolveGraphModelOrganizationId } from "@kiwi/ai/models";
import { getFile, putNamedFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { createWorkerClient } from "../lib/ai/client";
import { chunkItems } from "../lib/collections/chunk";
import { processFilesSpec } from "./process-files-spec";
import { deleteGraphFileProcessingArtifacts, getGraphFileArtifactPaths } from "../lib/files/artifacts";
import { buildMetadata, buildMetadataExcerpt } from "../lib/files/metadata";
import { processDescriptionsGroupsSpec, DESCRIPTION_BATCHES_PER_GROUP } from "./process-descriptions-group-spec";
import { updateDescriptionsSpec } from "./update-descriptions-spec";
import { DESCRIPTION_BATCH_SIZE } from "../lib/descriptions/workflow";
import { getFileTypeProcessingConfig } from "../lib/files/type-config";
import { requireReadableContentText } from "../lib/files/readable-text";
import { classifyFileProcessError } from "../lib/files/process-error";
import { collectPendingDescriptionTargets, saveGraphToDatabase } from "../lib/graph/save";
import { loadCodeRepositoryContextsByBranch, uploadCodeManifest } from "../lib/code/manifest";
import { buildAndSaveFastCodeGraphLayerFromContext } from "../lib/code/fast-layer";
import { invalidateSupersededRepositorySources } from "../lib/code/repository-finalizer";
import { updateFileProcessingState, stopIfFileDeleted } from "../lib/files/processing-state";
import { runWorkerEffect } from "../lib/runtime/effect";
import {
    fileProcessingWorkflow,
    shouldAbortRepositoryBatch,
    shouldFinalizeRepositoryBatch,
} from "../lib/files/workflow";
import { processFileSpec } from "./process-file-spec";

const FILE_DELETED = "__file_deleted__" as const;
const NO_RETRY = { maximumAttempts: 1 } as const;
const PROCESS_UNIT_BATCH_SIZE = 100;

function workflowError(error: unknown) {
    if (error instanceof Error) {
        return new Error(error.message, { cause: error });
    }

    return new Error("Workflow failed", { cause: error });
}

export const processFiles = defineWorkflow(processFilesSpec, async ({ input, step, run }) => {
    try {
        await step.run({ name: "mark-files-pending" }, async () =>
            runWorkerEffect(
                Effect.gen(function* () {
                    if (input.fileIds.length === 0) {
                        return;
                    }

                    yield* withWorkerDbVoid((db) =>
                        db
                            .update(filesTable)
                            .set({
                                processStep: "pending",
                                status: "processing",
                                processErrorCode: null,
                            })
                            .where(and(eq(filesTable.graphId, input.graphId), inArray(filesTable.id, input.fileIds)))
                    );
                })
            )
        );

        await step.run({ name: "update-project-status" }, async () =>
            runWorkerEffect(
                withWorkerDbVoid((db) =>
                    Effect.gen(function* () {
                        yield* db.update(graphTable).set({ state: "updating" }).where(eq(graphTable.id, input.graphId));

                        if (input.processRunId) {
                            yield* db
                                .update(processRunsTable)
                                .set({ status: "started", startedAt: sql`NOW()` })
                                .where(eq(processRunsTable.id, input.processRunId));
                        }
                    })
                )
            )
        );

        const fileTypeRows = await step.run({ name: "load-file-types" }, async () =>
            runWorkerEffect(
                Effect.gen(function* () {
                    if (input.fileIds.length === 0) {
                        return [];
                    }

                    return yield* withWorkerDb((db) =>
                        db
                            .select({
                                id: filesTable.id,
                                type: filesTable.type,
                            })
                            .from(filesTable)
                            .where(and(eq(filesTable.graphId, input.graphId), inArray(filesTable.id, input.fileIds)))
                    );
                })
            )
        );
        const fileTypes = new Map(fileTypeRows.map((file) => [file.id, coerceGraphFileType(file.type)]));
        const hasCodeFiles = [...fileTypes.values()].some((type) => type === "code");

        const codeFileIds = input.fileIds.filter((fileId) => fileTypes.get(fileId) === "code");
        const codeRepositoryContexts =
            input.code && hasCodeFiles
                ? await step.run({ name: "load-code-repository-contexts" }, async () =>
                      runWorkerEffect(
                          loadCodeRepositoryContextsByBranch({ graphId: input.graphId, fileIds: codeFileIds })
                      )
                  )
                : [];
        const defaultCodeRepositoryContext = codeRepositoryContexts.find((context) => context.isDefaultBranch);
        const defaultCodeFileIds = new Set(defaultCodeRepositoryContext?.files.map((file) => file.fileId) ?? []);
        const defaultSelectedCodeFileIds = codeFileIds.filter((fileId) => defaultCodeFileIds.has(fileId));
        const fastOnlyCodeFileIds = codeFileIds.filter((fileId) => !defaultCodeFileIds.has(fileId));
        const codeManifestKey = defaultCodeRepositoryContext
            ? await step.run({ name: "prepare-code-manifest" }, async () =>
                  runWorkerEffect(
                      uploadCodeManifest(defaultCodeRepositoryContext, {
                          graphId: input.graphId,
                          processRunId: input.processRunId,
                      })
                  )
              )
            : undefined;
        if (codeRepositoryContexts.length > 0) {
            await step.run({ name: "save-fast-code-layers" }, async () =>
                runWorkerEffect(
                    Effect.gen(function* () {
                        for (const context of codeRepositoryContexts) {
                            yield* buildAndSaveFastCodeGraphLayerFromContext(context, {
                                graphId: input.graphId,
                                processRunId: input.processRunId,
                            });
                        }
                    })
                )
            );
        }
        if (fastOnlyCodeFileIds.length > 0) {
            await step.run({ name: "mark-fast-only-code-files" }, async () =>
                runWorkerEffect(
                    Effect.gen(function* () {
                        for (const fileId of fastOnlyCodeFileIds) {
                            yield* updateFileProcessingState(fileId, "completed", "processed");
                        }
                    })
                )
            );
        }
        const fileIdsForComplexProcessing = input.fileIds.filter(
            (fileId) => fileTypes.get(fileId) !== "code" || defaultCodeFileIds.has(fileId)
        );
        const fileResults = await Promise.allSettled(
            fileIdsForComplexProcessing.map((fileId) => {
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
                runWorkerEffect(
                    invalidateSupersededRepositorySources(
                        input.code?.retiredFileIds !== undefined
                            ? {
                                  graphId: input.graphId,
                                  retiredFileIds: input.code.retiredFileIds,
                              }
                            : {
                                  graphId: input.graphId,
                                  latestFileIds: defaultSelectedCodeFileIds,
                              }
                    )
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

        const descriptions = await step.run({ name: "generate-descriptions" }, async () =>
            runWorkerEffect(collectPendingDescriptionTargets(input.graphId))
        );

        // Two-level fan-out: spawn groups of description batches to avoid exceeding
        // the OpenWorkflow step limit (1000) on large projects with many entities/relationships.
        // Each group spawns update-descriptions sub-workflows internally, so the parent workflow
        // only counts one step per group instead of one step per batch.
        const totalEntityBatches = chunkItems(descriptions.entityIds, DESCRIPTION_BATCH_SIZE).length;
        const totalRelationshipBatches = chunkItems(descriptions.relationshipIds, DESCRIPTION_BATCH_SIZE).length;
        const totalBatches = totalEntityBatches + totalRelationshipBatches;
        const groupsCount = Math.ceil(totalBatches / DESCRIPTION_BATCHES_PER_GROUP);

        const entityIdBatches = chunkItems(descriptions.entityIds, DESCRIPTION_BATCH_SIZE);
        const relationshipIdBatches = chunkItems(descriptions.relationshipIds, DESCRIPTION_BATCH_SIZE);
        const allBatches = [
            ...entityIdBatches.map((ids) => ({ entityIds: ids, relationshipIds: [] as string[] })),
            ...relationshipIdBatches.map((ids) => ({ entityIds: [] as string[], relationshipIds: ids })),
        ];

        const groupPromises = [];
        for (let i = 0; i < groupsCount; i++) {
            const groupBatches = allBatches.slice(
                i * DESCRIPTION_BATCHES_PER_GROUP,
                (i + 1) * DESCRIPTION_BATCHES_PER_GROUP
            );
            const groupEntityIds = groupBatches.flatMap((b) => b.entityIds);
            const groupRelationshipIds = groupBatches.flatMap((b) => b.relationshipIds);

            groupPromises.push(
                step.runWorkflow(processDescriptionsGroupsSpec, {
                    graphId: input.graphId,
                    entityIds: groupEntityIds,
                    relationshipIds: groupRelationshipIds,
                })
            );
        }

        await Promise.all(groupPromises);

        await step.run({ name: "finalize-project-status" }, async () =>
            runWorkerEffect(
                withWorkerDbVoid((db) =>
                    Effect.gen(function* () {
                        yield* db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId));

                        if (input.processRunId) {
                            yield* db
                                .update(processRunsTable)
                                .set({ status: "completed", completedAt: sql`NOW()` })
                                .where(eq(processRunsTable.id, input.processRunId));
                        }
                    })
                )
            )
        );
    } catch (error) {
        if (run.retryTerminal) {
            await step.run({ name: "mark-project-failed", retryPolicy: NO_RETRY }, async () =>
                runWorkerEffect(
                    withWorkerDbVoid((db) =>
                        Effect.gen(function* () {
                            yield* db
                                .update(graphTable)
                                .set({ state: "ready" })
                                .where(eq(graphTable.id, input.graphId));

                            if (input.processRunId) {
                                yield* db
                                    .update(processRunsTable)
                                    .set({ status: "failed", completedAt: sql`NOW()` })
                                    .where(eq(processRunsTable.id, input.processRunId));
                            }
                        })
                    )
                )
            );
        }

        throw workflowError(error);
    }
});

export const processFile = defineWorkflow(processFileSpec, async ({ input, step, run }) => {
    try {
        let fileData;
        [fileData] = await step.run({ name: "get-file-data" }, async () =>
            runWorkerEffect(
                withWorkerDb((db) =>
                    db
                        .select()
                        .from(filesTable)
                        .where(and(eq(filesTable.graphId, input.graphId), eq(filesTable.id, input.fileId)))
                        .limit(1)
                )
            )
        );

        if (!fileData) {
            return;
        }

        if (fileData.deleted) {
            await runWorkerEffect(updateFileProcessingState(input.fileId, "completed", "processed"));
            return;
        }

        const paths = getGraphFileArtifactPaths({
            graphId: input.graphId,
            fileId: input.fileId,
            fileKey: fileData.key,
        });

        const baseFile = await step.run({ name: "preprocess-file" }, async () =>
            runWorkerEffect(
                Effect.gen(function* () {
                    if (yield* stopIfFileDeleted(input.fileId)) {
                        return FILE_DELETED;
                    }

                    yield* updateFileProcessingState(input.fileId, "preprocessing", "processing");
                    const start = performance.now();
                    const client = yield* createWorkerClient(input.graphId);
                    const s3Loader = new S3Loader(fileData.key, env.S3_BUCKET);
                    const fileContent = yield* Effect.tryPromise(() => s3Loader.getBinary());
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
                    const organizationId = yield* resolveGraphModelOrganizationId(input.graphId);
                    const typeConfig = yield* getFileTypeProcessingConfig(organizationId, detectedFormat.fileType);
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
                        yield* withWorkerDbVoid((db) =>
                            db
                                .update(filesTable)
                                .set({
                                    type: detectedFormat.fileType,
                                    mimeType: detectedFormat.mimeType,
                                })
                                .where(eq(filesTable.id, input.fileId))
                        );

                        fileData.type = detectedFormat.fileType;
                        fileData.mimeType = detectedFormat.mimeType;
                    }

                    const graphFile = {
                        ...baseGraphFile,
                        loader,
                    } satisfies Omit<GraphFile, "chunker">;
                    const document = yield* Effect.tryPromise(() => loadGraphDocument(graphFile.loader));
                    const contentText = requireReadableContentText(document.text);
                    const tokens = estimateToken(contentText);
                    const uploadedDocument = yield* putNamedFile(
                        "document.json",
                        JSON.stringify(document),
                        paths.processingPrefix,
                        env.S3_BUCKET
                    );

                    const duration = performance.now() - start;

                    yield* withWorkerDbVoid((db) =>
                        db
                            .update(filesTable)
                            .set({
                                tokenCount: tokens,
                                loader: detectedFormat.loaderKind,
                                documentMode: typeConfig.documentMode,
                            })
                            .where(eq(filesTable.id, input.fileId))
                    );

                    return {
                        ...baseGraphFile,
                        documentKey: uploadedDocument.key,
                        duration,
                        tokenCount: tokens,
                        metadataExcerpt: buildMetadataExcerpt(contentText),
                    };
                })
            )
        );
        if (baseFile === FILE_DELETED) {
            return;
        }

        const metadataResult = await step.run({ name: "metadata" }, async () =>
            runWorkerEffect(
                Effect.gen(function* () {
                    if (yield* stopIfFileDeleted(input.fileId)) {
                        return FILE_DELETED;
                    }

                    yield* updateFileProcessingState(input.fileId, "metadata", "processing");
                    const client = yield* createWorkerClient(input.graphId);
                    const metadata = yield* buildMetadata(client.text, fileData.name, baseFile.metadataExcerpt);

                    yield* withWorkerDbVoid((db) =>
                        db
                            .update(filesTable)
                            .set({ metadata: metadata || null })
                            .where(eq(filesTable.id, input.fileId))
                    );

                    return {
                        metadata,
                    };
                })
            )
        );
        if (metadataResult === FILE_DELETED) {
            return;
        }

        const unitsResult = await step.run({ name: "build-units" }, async () =>
            runWorkerEffect(
                Effect.gen(function* () {
                    if (yield* stopIfFileDeleted(input.fileId)) {
                        return FILE_DELETED;
                    }

                    yield* updateFileProcessingState(input.fileId, "chunking", "processing");
                    const start = performance.now();

                    const organizationId = yield* resolveGraphModelOrganizationId(input.graphId);
                    const typeConfig = yield* getFileTypeProcessingConfig(
                        organizationId,
                        coerceGraphFileType(baseFile.filetype)
                    );
                    const chunker = createGraphChunker(typeConfig.chunker, typeConfig.chunkSize);

                    yield* withWorkerDbVoid((db) =>
                        db
                            .update(filesTable)
                            .set({
                                chunker: typeConfig.chunker,
                                chunkSize: typeConfig.chunkSize,
                            })
                            .where(eq(filesTable.id, input.fileId))
                    );

                    const loadedDocument = yield* getFile<LoadedGraphDocument>(
                        baseFile.documentKey,
                        env.S3_BUCKET,
                        "json"
                    );
                    if (!loadedDocument) {
                        return yield* Effect.fail(new Error(`Failed to load document from ${baseFile.documentKey}`));
                    }

                    const units = yield* createUnitsFromText({
                        fileId: baseFile.id,
                        fileType: baseFile.filetype,
                        text: loadedDocument.content.text,
                        chunker,
                        loaderSourceChunks: loadedDocument.content.sourceChunks,
                    });
                    const uploadedUnits = yield* putNamedFile(
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
                })
            )
        );
        if (unitsResult === FILE_DELETED) {
            return;
        }

        const graphResult = await step.run({ name: "build-graph" }, async () =>
            runWorkerEffect(
                Effect.gen(function* () {
                    if (yield* stopIfFileDeleted(input.fileId)) {
                        return FILE_DELETED;
                    }

                    yield* updateFileProcessingState(input.fileId, "extracting", "processing");
                    const start = performance.now();
                    const client = yield* createWorkerClient(input.graphId);

                    const loadedUnits = yield* getFile<Unit[]>(unitsResult.unitsKey, env.S3_BUCKET, "json");
                    if (!loadedUnits) {
                        return yield* Effect.fail(new Error(`Failed to load units from ${unitsResult.unitsKey}`));
                    }

                    const graphs: Graph[] = [];
                    for (const units of chunkItems(loadedUnits.content, PROCESS_UNIT_BATCH_SIZE)) {
                        graphs.push(
                            ...(yield* Effect.all(
                                units.map((unit) =>
                                    processUnit(unit, client.text, fileData.name, metadataResult.metadata || undefined)
                                )
                            ))
                        );
                    }
                    const mergedGraph = mergeGraphs(graphs);
                    const graph = dedupe(mergedGraph);
                    const uploadedGraph = yield* putNamedFile(
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
                })
            )
        );
        if (graphResult === FILE_DELETED) {
            return;
        }

        const saveGraphResult = await step.run({ name: "save-graph" }, async () =>
            runWorkerEffect(
                Effect.gen(function* () {
                    if (yield* stopIfFileDeleted(input.fileId)) {
                        return FILE_DELETED;
                    }

                    yield* updateFileProcessingState(input.fileId, "deduplicating", "processing");
                    yield* updateFileProcessingState(input.fileId, "saving", "processing");

                    const loadedGraph = yield* getFile<Graph>(graphResult.graphKey, env.S3_BUCKET, "json");
                    if (!loadedGraph) {
                        return yield* Effect.fail(new Error(`Failed to load graph from ${graphResult.graphKey}`));
                    }

                    const saveResult = yield* saveGraphToDatabase(input.graphId, loadedGraph.content);

                    return {
                        summary: {
                            fileId: input.fileId,
                            ...saveResult.summary,
                        },
                        duration: saveResult.duration,
                        metrics: saveResult.metrics,
                    };
                })
            )
        );
        if (saveGraphResult === FILE_DELETED) {
            return;
        }

        const statsResult = await step.run({ name: "store-process-stats" }, async () =>
            runWorkerEffect(
                Effect.gen(function* () {
                    if (yield* stopIfFileDeleted(input.fileId)) {
                        return FILE_DELETED;
                    }
                    yield* Effect.catch(
                        withWorkerDbVoid((db) => {
                            const totalTime =
                                baseFile.duration +
                                unitsResult.duration +
                                graphResult.duration +
                                saveGraphResult.duration;

                            return db.insert(processStatsTable).values({
                                totalTime,
                                files: 1,
                                fileSizes: fileData.size,
                                fileType: baseFile.filetype,
                                tokenCount: baseFile.tokenCount,
                            });
                        }),
                        (error: unknown) =>
                            Effect.sync(() => {
                                logError("failed to store file process stats", {
                                    graphId: input.graphId,
                                    fileId: input.fileId,
                                    error,
                                });
                            })
                    );
                })
            )
        );
        if (statsResult === FILE_DELETED) {
            return;
        }

        await step.run({ name: "mark-file-complete" }, async () =>
            runWorkerEffect(updateFileProcessingState(input.fileId, "completed", "processed"))
        );

        await step.run({ name: "cleanup-processing-artifacts" }, async () =>
            runWorkerEffect(
                Effect.matchEffect(
                    deleteGraphFileProcessingArtifacts({
                        graphId: input.graphId,
                        fileId: input.fileId,
                        fileKey: fileData.key,
                        bucket: env.S3_BUCKET,
                    }),
                    {
                        onFailure: (error) =>
                            Effect.sync(() => {
                                logError("failed to cleanup processing artifacts", {
                                    graphId: input.graphId,
                                    fileId: input.fileId,
                                    error,
                                });
                                return { deletedKeyCount: 0 };
                            }),
                        onSuccess: (value) => Effect.succeed(value),
                    }
                )
            )
        );

        return saveGraphResult.summary;
    } catch (error) {
        if (run.retryTerminal) {
            await runWorkerEffect(
                updateFileProcessingState(input.fileId, "failed", "failed", classifyFileProcessError(error))
            );
        } else {
            await runWorkerEffect(updateFileProcessingState(input.fileId, "pending", "processing", null));
        }

        throw workflowError(error);
    }
});
