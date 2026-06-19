import * as Effect from "effect/Effect";
import { withWorkerDb, withWorkerDbVoid } from "../lib/effect";
import { filesTable, processStatsTable } from "@kiwi/db/tables/graph";
import { and, eq } from "drizzle-orm";
import { defineWorkflow } from "openworkflow";
import z from "zod";
import { estimateToken } from "@kiwi/ai";
import type { Graph } from "@kiwi/graph";
import type { CodeRepositoryFile } from "@kiwi/graph/code/repository";
import { getFile, putNamedFile } from "@kiwi/files";
import { error as logError } from "@kiwi/logger";
import { env } from "../env";
import { deleteGraphFileProcessingArtifacts, getGraphFileArtifactPaths } from "../lib/derived-files";
import { classifyFileProcessError } from "../lib/file-process-error";
import { loadCodeManifest } from "../lib/code-manifest";
import { fileContentSourceFromRow, readFileContentSource } from "../lib/file-content-source";
import { codeRepositoryFileFieldsFromMetadata, parseCodeFileMetadata } from "../lib/code-file-metadata";
import { updateFileProcessingState, stopIfFileDeleted } from "../lib/file-processing-state";
import { saveGraphToDatabase } from "../lib/save-graph";
import { runWorkerEffect } from "../lib/effect";

const FILE_DELETED = "__file_deleted__" as const;

type ProcessFileRow = typeof filesTable.$inferSelect;

function workflowError(error: unknown) {
    if (error instanceof Error) {
        return new Error(error.message, { cause: error });
    }

    return new Error("Workflow failed", { cause: error });
}

function codeRepositoryFileFromRow(file: ProcessFileRow, content: string): CodeRepositoryFile {
    const metadata = parseCodeFileMetadata(file.metadata);

    const fields = codeRepositoryFileFieldsFromMetadata(metadata, { graphId: file.graphId, name: file.name });

    return {
        fileId: file.id,
        ...fields,
        content,
    };
}

export const processCodeFile = defineWorkflow(
    {
        name: "process-code-file",
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
            codeManifestKey: z.string().optional(),
        }),
    },
    async ({ input, step, run }) => {
        try {
            const [fileData] = await step.run({ name: "get-code-file-data" }, async () =>
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

            const baseFile = await step.run({ name: "preprocess-code-file" }, async () =>
                runWorkerEffect(
                    Effect.gen(function* () {
                        if (yield* stopIfFileDeleted(input.fileId)) {
                            return FILE_DELETED;
                        }

                        yield* updateFileProcessingState(input.fileId, "preprocessing", "processing");
                        const start = performance.now();
                        const source = yield* readFileContentSource(fileContentSourceFromRow(fileData));
                        if (source === null) {
                            return yield* Effect.fail(new Error(`Failed to load file ${fileData.key}`));
                        }

                        if (source.trim() === "") {
                            return yield* Effect.fail(new Error("No readable text found in file"));
                        }

                        const repositoryFile = codeRepositoryFileFromRow(fileData, source);
                        const tokenCount = estimateToken(source);

                        yield* withWorkerDbVoid((db) =>
                            db
                                .update(filesTable)
                                .set({ tokenCount, loader: "repository", chunker: "ast" })
                                .where(eq(filesTable.id, input.fileId))
                        );

                        return {
                            repositoryFile,
                            duration: performance.now() - start,
                            tokenCount,
                        };
                    })
                )
            );
            if (baseFile === FILE_DELETED) {
                return;
            }

            const graphResult = await step.run({ name: "build-code-graph" }, async () =>
                runWorkerEffect(
                    Effect.gen(function* () {
                        if (yield* stopIfFileDeleted(input.fileId)) {
                            return FILE_DELETED;
                        }

                        yield* updateFileProcessingState(input.fileId, "extracting", "processing");
                        const start = performance.now();
                        const { buildCodeFileGraph, buildCodeRepositoryManifest } = yield* Effect.tryPromise(() =>
                            import("@kiwi/graph/code/repository")
                        );
                        const manifest = input.codeManifestKey
                            ? yield* loadCodeManifest(input.codeManifestKey)
                            : buildCodeRepositoryManifest([baseFile.repositoryFile]);
                        const graph = buildCodeFileGraph(baseFile.repositoryFile, manifest);
                        const uploadedGraph = yield* putNamedFile(
                            "graph.json",
                            JSON.stringify(graph),
                            paths.processingPrefix,
                            env.S3_BUCKET
                        );

                        return {
                            graphKey: uploadedGraph.key,
                            duration: performance.now() - start,
                        };
                    })
                )
            );
            if (graphResult === FILE_DELETED) {
                return;
            }

            const saveGraphResult = await step.run({ name: "save-code-graph" }, async () =>
                runWorkerEffect(
                    Effect.gen(function* () {
                        if (yield* stopIfFileDeleted(input.fileId)) {
                            return FILE_DELETED;
                        }

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

            const statsResult = await step.run({ name: "store-code-process-stats" }, async () =>
                runWorkerEffect(
                    Effect.gen(function* () {
                        if (yield* stopIfFileDeleted(input.fileId)) {
                            return FILE_DELETED;
                        }
                        yield* Effect.catch(
                            withWorkerDbVoid((db) =>
                                db.insert(processStatsTable).values({
                                    totalTime: baseFile.duration + graphResult.duration + saveGraphResult.duration,
                                    files: 1,
                                    fileSizes: fileData.size,
                                    fileType: "code",
                                    tokenCount: baseFile.tokenCount,
                                })
                            ),
                            (error: unknown) =>
                                Effect.sync(() => {
                                    logError("failed to store code file process stats", {
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

            await step.run({ name: "mark-code-file-complete" }, async () =>
                runWorkerEffect(updateFileProcessingState(input.fileId, "completed", "processed"))
            );

            await step.run({ name: "cleanup-code-processing-artifacts" }, async () =>
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
                                    logError("failed to cleanup code processing artifacts", {
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
                await runWorkerEffect(updateFileProcessingState(input.fileId, "failed", "failed", classifyFileProcessError(error)));
            } else {
                await runWorkerEffect(updateFileProcessingState(input.fileId, "pending", "processing", null));
            }

            throw workflowError(error);
        }
    }
);
