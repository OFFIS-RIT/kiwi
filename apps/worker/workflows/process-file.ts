import { db } from "@kiwi/db";
import {
    type FileProcessStatus,
    type FileProcessStep,
    entityTable,
    filesTable,
    graphTable,
    processRunsTable,
    processStatsTable,
    relationshipTable,
    sourcesTable,
    textUnitTable,
} from "@kiwi/db/tables/graph";
import { and, eq, inArray, sql } from "drizzle-orm";
import { defineWorkflow } from "openworkflow";
import z from "zod";
import { S3Loader } from "@kiwi/graph/loader/s3";
import { PDFLoader } from "@kiwi/graph/loader/pdf";
import { ImageLoader } from "@kiwi/graph/loader/image";
import { JSONChunker } from "@kiwi/graph/chunker/json";
import { SingleChunker } from "@kiwi/graph/chunker/single";
import { SemanticChunker } from "@kiwi/graph/chunker/semantic";
import { env } from "../env";
import { type Graph, type GraphChunker, type GraphFile, type GraphLoader, type Unit } from "@kiwi/graph";
import { dedupe } from "@kiwi/graph/dedupe";
import { mergeGraphs } from "@kiwi/graph/merge";
import { createUnits, processUnit } from "@kiwi/graph/unit";
import { DOCXLoader } from "@kiwi/graph/loader/doc";
import { estimateToken, getClient } from "@kiwi/ai";
import { ExcelLoader } from "@kiwi/graph/loader/excel";
import { PPTXLoader } from "@kiwi/graph/loader/ppt";
import { getFile, putNamedFile } from "@kiwi/files";
import { buildAdapter, buildEmbeddingAdapter } from "../lib/ai";
import { EMPTY_VECTOR_SQL, entityNameKey, textArray } from "../lib/sql";
import { chunkItems } from "../lib/chunk";
import { processFilesSpec } from "./process-files-spec";
import { getDerivedFilePrefix, getDerivedImagePrefix } from "../lib/derived-files";
import { buildPDFLoaderOptions } from "../lib/pdf-loader";
import { buildMetadata, buildMetadataExcerpt } from "../lib/metadata";
import { updateDescriptionsSpec } from "./update-descriptions-spec";
import { DESCRIPTION_BATCH_SIZE } from "../lib/description-workflow";

const WORKFLOW_STORAGE_VERSION = "v1";
const FILE_DELETED = "__file_deleted__" as const;
const NO_RETRY = { maximumAttempts: 1 } as const;

function workflowError(error: unknown) {
    if (error instanceof Error) {
        return new Error(error.message, { cause: error });
    }

    return new Error("Workflow failed", { cause: error });
}

async function updateFileProcessingState(fileId: string, processStep: FileProcessStep, status: FileProcessStatus) {
    await db
        .update(filesTable)
        .set({
            processStep,
            status,
        })
        .where(eq(filesTable.id, fileId));
}

async function stopIfFileDeleted(fileId: string) {
    const [file] = await db
        .select({ deleted: filesTable.deleted })
        .from(filesTable)
        .where(eq(filesTable.id, fileId))
        .limit(1);

    if (file?.deleted) {
        await updateFileProcessingState(fileId, "completed", "processed");
        return true;
    }

    return false;
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
                })
                .where(and(eq(filesTable.graphId, input.graphId), inArray(filesTable.id, input.fileIds)));
        });

        // Update project status
        await step.run({ name: "update-project-status" }, async () => {
            await Promise.all([
                db.update(graphTable).set({ state: "updating" }).where(eq(graphTable.id, input.graphId)),
                db
                    .update(processRunsTable)
                    .set({ status: "started", startedAt: sql`NOW()` })
                    .where(eq(processRunsTable.id, input.processRunId)),
            ]);
        });

        await Promise.allSettled(
            input.fileIds.map((fileId) =>
                step.runWorkflow(processFile.spec, {
                    graphId: input.graphId,
                    fileId,
                })
            )
        );

        const descriptions = await step.run({ name: "generate-descriptions" }, async () => {
            const newEntities = await db
                .select({ id: entityTable.id, name: entityTable.name })
                .from(entityTable)
                .where(and(eq(entityTable.graphId, input.graphId), eq(entityTable.active, false)));

            const updatedEntityRows = await db
                .selectDistinct({
                    id: entityTable.id,
                    name: entityTable.name,
                    description: entityTable.description,
                })
                .from(entityTable)
                .innerJoin(sourcesTable, eq(sourcesTable.entityId, entityTable.id))
                .where(
                    and(
                        eq(entityTable.graphId, input.graphId),
                        eq(entityTable.active, true),
                        eq(sourcesTable.active, false)
                    )
                );
            const updatedEntities = Array.from(
                new Map(updatedEntityRows.map((entity) => [entity.id, entity])).values()
            );

            const entityIds = [
                ...newEntities.map((entity) => entity.id),
                ...updatedEntities.map((entity) => entity.id),
            ];

            const newRelationships = await db
                .select({
                    id: relationshipTable.id,
                    sourceId: relationshipTable.sourceId,
                    targetId: relationshipTable.targetId,
                })
                .from(relationshipTable)
                .where(and(eq(relationshipTable.graphId, input.graphId), eq(relationshipTable.active, false)));

            const updatedRelationshipRows = await db
                .selectDistinct({
                    id: relationshipTable.id,
                    sourceId: relationshipTable.sourceId,
                    targetId: relationshipTable.targetId,
                    description: relationshipTable.description,
                })
                .from(relationshipTable)
                .innerJoin(sourcesTable, eq(sourcesTable.relationshipId, relationshipTable.id))
                .where(
                    and(
                        eq(relationshipTable.graphId, input.graphId),
                        eq(relationshipTable.active, true),
                        eq(sourcesTable.active, false)
                    )
                );
            const updatedRelationships = Array.from(
                new Map(updatedRelationshipRows.map((relationship) => [relationship.id, relationship])).values()
            );

            const relationshipIds = [
                ...newRelationships.map((relationship) => relationship.id),
                ...updatedRelationships.map((relationship) => relationship.id),
            ];

            return {
                entityIds,
                relationshipIds,
            };
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
            await Promise.all([
                db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId)),
                db
                    .update(processRunsTable)
                    .set({ status: "completed", completedAt: sql`NOW()` })
                    .where(eq(processRunsTable.id, input.processRunId)),
            ]);
        });
    } catch (error) {
        if (run.retryTerminal) {
            await step.run({ name: "mark-project-failed", retryPolicy: NO_RETRY }, async () => {
                await Promise.all([
                    db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId)),
                    db
                        .update(processRunsTable)
                        .set({ status: "failed", completedAt: sql`NOW()` })
                        .where(eq(processRunsTable.id, input.processRunId)),
                ]);
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

            const client = getClient({
                text: buildAdapter(
                    env.AI_TEXT_ADAPTER,
                    env.AI_TEXT_MODEL,
                    env.AI_TEXT_KEY,
                    env.AI_TEXT_URL,
                    env.AI_TEXT_RESOURCE_NAME
                ),
                embedding: buildEmbeddingAdapter(
                    env.AI_EMBEDDING_ADAPTER,
                    env.AI_EMBEDDING_MODEL,
                    env.AI_EMBEDDING_KEY,
                    env.AI_EMBEDDING_URL,
                    env.AI_EMBEDDING_RESOURCE_NAME
                ),
                image:
                    env.AI_IMAGE_ADAPTER && env.AI_IMAGE_MODEL && env.AI_IMAGE_KEY
                        ? buildAdapter(
                              env.AI_IMAGE_ADAPTER,
                              env.AI_IMAGE_MODEL,
                              env.AI_IMAGE_KEY,
                              env.AI_IMAGE_URL,
                              env.AI_IMAGE_RESOURCE_NAME
                          )
                        : undefined,
            });

            const baseFile = await step.run({ name: "preprocess-file" }, async () => {
                if (await stopIfFileDeleted(input.fileId)) {
                    return FILE_DELETED;
                }

                await updateFileProcessingState(input.fileId, "preprocessing", "processing");
                const start = performance.now();
                const s3Loader = new S3Loader(fileData.key, env.S3_BUCKET);
                const derivedPrefix = getDerivedFilePrefix(input.graphId, input.fileId);
                const derivedImagePrefix = getDerivedImagePrefix(input.graphId, input.fileId);
                const baseGraphFile = {
                    id: input.fileId,
                    key: fileData.key,
                    filename: fileData.name,
                    filetype: fileData.type,
                } satisfies Omit<GraphFile, "loader" | "chunker">;
                let loader: GraphLoader;

                switch (fileData.type) {
                    case "pdf": {
                        loader = new PDFLoader(buildPDFLoaderOptions(s3Loader, client.image));
                        break;
                    }
                    case "doc": {
                        if (!client.image) {
                            throw new Error("Image adapter is not configured");
                        }
                        loader = new DOCXLoader({
                            ocr: true,
                            loader: s3Loader,
                            model: client.image,
                            storage: {
                                bucket: env.S3_BUCKET,
                                imagePrefix: derivedImagePrefix,
                            },
                        });
                        break;
                    }
                    case "sheet": {
                        loader = new ExcelLoader({ loader: s3Loader });
                        break;
                    }
                    case "ppt": {
                        if (!client.image) {
                            throw new Error("Image adapter is not configured");
                        }
                        loader = new PPTXLoader({
                            ocr: true,
                            loader: s3Loader,
                            model: client.image,
                            storage: {
                                bucket: env.S3_BUCKET,
                                imagePrefix: derivedImagePrefix,
                            },
                        });
                        break;
                    }
                    case "image": {
                        if (!client.image) {
                            throw new Error("Image adapter is not configured");
                        }
                        loader = new ImageLoader({
                            loader: s3Loader,
                            model: client.image,
                        });
                        break;
                    }
                    default:
                        loader = s3Loader;
                }

                const graphFile = {
                    ...baseGraphFile,
                    loader,
                } satisfies Omit<GraphFile, "chunker">;
                const text = await graphFile.loader.getText();
                let sourceKey = fileData.key;

                if (
                    graphFile.filetype === "pdf" ||
                    graphFile.filetype === "image" ||
                    graphFile.filetype === "doc" ||
                    graphFile.filetype === "sheet" ||
                    graphFile.filetype === "ppt"
                ) {
                    const uploadedFile = await putNamedFile("source.txt", text, derivedPrefix, env.S3_BUCKET);
                    sourceKey = uploadedFile.key;
                }

                const duration = performance.now() - start;
                const tokens = estimateToken(text);

                await db
                    .update(filesTable)
                    .set({
                        tokenCount: tokens,
                    })
                    .where(eq(filesTable.id, input.fileId));

                return {
                    ...baseGraphFile,
                    sourceKey,
                    duration,
                    tokenCount: tokens,
                    metadataExcerpt: buildMetadataExcerpt(text),
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
                const metadata = await buildMetadata(client.text!, fileData.name, baseFile.metadataExcerpt);

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

                let chunker: GraphChunker;
                switch (fileData.type) {
                    case "image":
                        chunker = new SingleChunker();
                        break;
                    case "json":
                        chunker = new JSONChunker({ maxChunkSize: 500 });
                        break;
                    default:
                        chunker = new SemanticChunker(2000);
                }

                const unitsFile = {
                    ...baseFile,
                    key: baseFile.sourceKey,
                    loader: new S3Loader(baseFile.sourceKey, env.S3_BUCKET),
                    chunker,
                } satisfies GraphFile;
                const units = await createUnits(unitsFile);

                const unitsPath = `graphs/${input.graphId}/workflows/${WORKFLOW_STORAGE_VERSION}/${input.fileId}`;
                const uploadedUnitsFile = await putNamedFile(
                    "units.json",
                    JSON.stringify(units),
                    unitsPath,
                    env.S3_BUCKET
                );

                const duration = performance.now() - start;

                return {
                    key: uploadedUnitsFile.key,
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

                const loadedUnits = await getFile<Unit[]>(unitsResult.key, env.S3_BUCKET, "json");
                if (!loadedUnits) {
                    throw new Error(`Failed to load units from ${unitsResult.key}`);
                }

                const graphs = await Promise.all(
                    loadedUnits.content.map((unit) =>
                        processUnit(unit, client.text!, fileData.name, metadataResult.metadata || undefined)
                    )
                );
                const mergedGraph = mergeGraphs(graphs);
                const graph = dedupe(mergedGraph);

                const graphPath = `graphs/${input.graphId}/workflows/${WORKFLOW_STORAGE_VERSION}/${input.fileId}`;
                const uploadedGraphFile = await putNamedFile(
                    "graph.json",
                    JSON.stringify(graph),
                    graphPath,
                    env.S3_BUCKET
                );

                const duration = performance.now() - start;

                return {
                    key: uploadedGraphFile.key,
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
                const start = performance.now();

                const loadedGraph = await getFile<Graph>(graphResult.key, env.S3_BUCKET, "json");
                if (!loadedGraph) {
                    throw new Error(`Failed to load graph from ${graphResult.key}`);
                }

                await updateFileProcessingState(input.fileId, "saving", "processing");

                const graph = loadedGraph.content;
                const unitRows = graph.units.map((unit) => ({
                    id: unit.id,
                    fileId: unit.fileId,
                    text: unit.content,
                }));
                const entityRows = graph.entities.map((entity) => ({
                    id: entity.id,
                    graphId: input.graphId,
                    active: false,
                    name: entity.name,
                    description: "",
                    type: entity.type,
                    embedding: EMPTY_VECTOR_SQL,
                }));
                const sourceRows = [
                    ...graph.entities.flatMap((entity) =>
                        entity.sources.map((source) => ({
                            id: source.id,
                            entityId: entity.id,
                            relationshipId: null,
                            textUnitId: source.unitId,
                            active: false,
                            description: source.description,
                            embedding: EMPTY_VECTOR_SQL,
                        }))
                    ),
                    ...graph.relationships.flatMap((relationship) =>
                        relationship.sources.map((source) => ({
                            id: source.id,
                            entityId: null,
                            relationshipId: relationship.id,
                            textUnitId: source.unitId,
                            active: false,
                            description: source.description,
                            embedding: EMPTY_VECTOR_SQL,
                        }))
                    ),
                ];
                const relationshipRows = graph.relationships.map((relationship) => ({
                    id: relationship.id,
                    active: false,
                    sourceId: relationship.sourceId,
                    targetId: relationship.targetId,
                    graphId: input.graphId,
                    rank: relationship.strength,
                    description: "",
                    embedding: EMPTY_VECTOR_SQL,
                }));

                const insertedEntityIds = entityRows.map((entity) => entity.id);
                const insertedRelationshipIds = relationshipRows.map((relationship) => relationship.id);

                const metrics = await db.transaction(async (tx) => {
                    const insertUnitsStart = performance.now();
                    for (const chunk of chunkItems(unitRows)) {
                        await tx
                            .insert(textUnitTable)
                            .values(chunk)
                            .onConflictDoUpdate({
                                target: textUnitTable.id,
                                set: {
                                    fileId: sql`excluded.file_id`,
                                    text: sql`excluded.text`,
                                    updatedAt: sql`NOW()`,
                                },
                            });
                    }
                    const insertUnitsDuration = performance.now() - insertUnitsStart;

                    const insertEntitiesStart = performance.now();
                    for (const chunk of chunkItems(entityRows)) {
                        await tx.insert(entityTable).values(chunk).onConflictDoNothing();
                    }
                    const insertEntitiesDuration = performance.now() - insertEntitiesStart;

                    const insertRelationshipsStart = performance.now();
                    for (const chunk of chunkItems(relationshipRows)) {
                        await tx.insert(relationshipTable).values(chunk).onConflictDoNothing();
                    }
                    for (const chunk of chunkItems(sourceRows)) {
                        await tx.insert(sourcesTable).values(chunk).onConflictDoNothing();
                    }
                    const insertRelationshipsDuration = performance.now() - insertRelationshipsStart;

                    const dedupeEntitiesStart = performance.now();
                    if (insertedEntityIds.length > 0) {
                        const entityIds = textArray(insertedEntityIds);
                        const candidateNameKeySql = sql.raw(entityNameKey("candidate.name"));
                        const seededNameKeySql = sql.raw(entityNameKey("seed.name"));

                        await tx.execute(sql`
                        WITH seeded_keys AS (
                            SELECT DISTINCT seed.type, ${seededNameKeySql} AS normalized_name
                            FROM entities seed
                            WHERE seed.graph_id = ${input.graphId}
                              AND seed.id = ANY(${entityIds})
                        ), duplicates AS (
                            SELECT
                                candidate.id,
                                first_value(candidate.id) OVER (
                                    PARTITION BY candidate.graph_id, candidate.type, ${candidateNameKeySql}
                                    ORDER BY candidate.active DESC, candidate.id ASC
                                ) AS canonical_id
                            FROM entities candidate
                            JOIN seeded_keys seeded
                              ON seeded.type = candidate.type
                             AND seeded.normalized_name = ${candidateNameKeySql}
                            WHERE candidate.graph_id = ${input.graphId}
                        )
                        UPDATE sources source
                        SET entity_id = duplicates.canonical_id
                        FROM duplicates
                        WHERE source.entity_id = duplicates.id
                          AND duplicates.id <> duplicates.canonical_id
                    `);

                        await tx.execute(sql`
                        WITH seeded_keys AS (
                            SELECT DISTINCT seed.type, ${seededNameKeySql} AS normalized_name
                            FROM entities seed
                            WHERE seed.graph_id = ${input.graphId}
                              AND seed.id = ANY(${entityIds})
                        ), duplicates AS (
                            SELECT
                                candidate.id,
                                first_value(candidate.id) OVER (
                                    PARTITION BY candidate.graph_id, candidate.type, ${candidateNameKeySql}
                                    ORDER BY candidate.active DESC, candidate.id ASC
                                ) AS canonical_id
                            FROM entities candidate
                            JOIN seeded_keys seeded
                              ON seeded.type = candidate.type
                             AND seeded.normalized_name = ${candidateNameKeySql}
                            WHERE candidate.graph_id = ${input.graphId}
                        )
                        UPDATE relationships relationship
                        SET source_id = duplicates.canonical_id
                        FROM duplicates
                        WHERE relationship.source_id = duplicates.id
                          AND relationship.graph_id = ${input.graphId}
                          AND duplicates.id <> duplicates.canonical_id
                    `);

                        await tx.execute(sql`
                        WITH seeded_keys AS (
                            SELECT DISTINCT seed.type, ${seededNameKeySql} AS normalized_name
                            FROM entities seed
                            WHERE seed.graph_id = ${input.graphId}
                              AND seed.id = ANY(${entityIds})
                        ), duplicates AS (
                            SELECT
                                candidate.id,
                                first_value(candidate.id) OVER (
                                    PARTITION BY candidate.graph_id, candidate.type, ${candidateNameKeySql}
                                    ORDER BY candidate.active DESC, candidate.id ASC
                                ) AS canonical_id
                            FROM entities candidate
                            JOIN seeded_keys seeded
                              ON seeded.type = candidate.type
                             AND seeded.normalized_name = ${candidateNameKeySql}
                            WHERE candidate.graph_id = ${input.graphId}
                        )
                        UPDATE relationships relationship
                        SET target_id = duplicates.canonical_id
                        FROM duplicates
                        WHERE relationship.target_id = duplicates.id
                          AND relationship.graph_id = ${input.graphId}
                          AND duplicates.id <> duplicates.canonical_id
                    `);

                        await tx.execute(sql`
                        WITH seeded_keys AS (
                            SELECT DISTINCT seed.type, ${seededNameKeySql} AS normalized_name
                            FROM entities seed
                            WHERE seed.graph_id = ${input.graphId}
                              AND seed.id = ANY(${entityIds})
                        ), duplicates AS (
                            SELECT
                                candidate.id,
                                first_value(candidate.id) OVER (
                                    PARTITION BY candidate.graph_id, candidate.type, ${candidateNameKeySql}
                                    ORDER BY candidate.active DESC, candidate.id ASC
                                ) AS canonical_id
                            FROM entities candidate
                            JOIN seeded_keys seeded
                              ON seeded.type = candidate.type
                             AND seeded.normalized_name = ${candidateNameKeySql}
                            WHERE candidate.graph_id = ${input.graphId}
                        )
                        DELETE FROM entities entity
                        USING duplicates
                        WHERE entity.id = duplicates.id
                          AND duplicates.id <> duplicates.canonical_id
                    `);
                    }
                    const dedupeEntitiesDuration = performance.now() - dedupeEntitiesStart;

                    const dedupeRelationshipsStart = performance.now();
                    await tx.execute(sql`
                    DELETE FROM relationships
                    WHERE graph_id = ${input.graphId}
                      AND source_id = target_id
                `);

                    if (insertedRelationshipIds.length > 0) {
                        const relationshipIds = textArray(insertedRelationshipIds);

                        await tx.execute(sql`
                        WITH seeded_pairs AS (
                            SELECT DISTINCT
                                least(relationship.source_id, relationship.target_id) AS pair_source_id,
                                greatest(relationship.source_id, relationship.target_id) AS pair_target_id
                            FROM relationships relationship
                            WHERE relationship.graph_id = ${input.graphId}
                              AND relationship.id = ANY(${relationshipIds})
                        ), duplicates AS (
                            SELECT
                                relationship.id,
                                least(relationship.source_id, relationship.target_id) AS canonical_source_id,
                                greatest(relationship.source_id, relationship.target_id) AS canonical_target_id,
                                first_value(relationship.id) OVER (
                                    PARTITION BY relationship.graph_id, least(relationship.source_id, relationship.target_id), greatest(relationship.source_id, relationship.target_id)
                                    ORDER BY relationship.active DESC, relationship.id ASC
                                ) AS canonical_id,
                                max(relationship.rank) OVER (
                                    PARTITION BY relationship.graph_id, least(relationship.source_id, relationship.target_id), greatest(relationship.source_id, relationship.target_id)
                                ) AS canonical_rank
                            FROM relationships relationship
                            JOIN seeded_pairs seeded
                              ON seeded.pair_source_id = least(relationship.source_id, relationship.target_id)
                             AND seeded.pair_target_id = greatest(relationship.source_id, relationship.target_id)
                            WHERE relationship.graph_id = ${input.graphId}
                        )
                        UPDATE relationships relationship
                        SET source_id = duplicates.canonical_source_id,
                            target_id = duplicates.canonical_target_id,
                            rank = CASE
                                WHEN relationship.id = duplicates.canonical_id THEN duplicates.canonical_rank
                                ELSE relationship.rank
                            END,
                            updated_at = NOW()
                        FROM duplicates
                        WHERE relationship.id = duplicates.id
                          AND (
                              relationship.source_id <> duplicates.canonical_source_id
                              OR relationship.target_id <> duplicates.canonical_target_id
                              OR (
                                  relationship.id = duplicates.canonical_id
                                  AND relationship.rank <> duplicates.canonical_rank
                              )
                          )
                    `);

                        await tx.execute(sql`
                        WITH seeded_pairs AS (
                            SELECT DISTINCT
                                least(relationship.source_id, relationship.target_id) AS pair_source_id,
                                greatest(relationship.source_id, relationship.target_id) AS pair_target_id
                            FROM relationships relationship
                            WHERE relationship.graph_id = ${input.graphId}
                              AND relationship.id = ANY(${relationshipIds})
                        ), duplicates AS (
                            SELECT
                                relationship.id,
                                first_value(relationship.id) OVER (
                                    PARTITION BY relationship.graph_id, least(relationship.source_id, relationship.target_id), greatest(relationship.source_id, relationship.target_id)
                                    ORDER BY relationship.active DESC, relationship.id ASC
                                ) AS canonical_id
                            FROM relationships relationship
                            JOIN seeded_pairs seeded
                              ON seeded.pair_source_id = least(relationship.source_id, relationship.target_id)
                             AND seeded.pair_target_id = greatest(relationship.source_id, relationship.target_id)
                            WHERE relationship.graph_id = ${input.graphId}
                        )
                        UPDATE sources source
                        SET relationship_id = duplicates.canonical_id
                        FROM duplicates
                        WHERE source.relationship_id = duplicates.id
                          AND duplicates.id <> duplicates.canonical_id
                    `);

                        await tx.execute(sql`
                        WITH seeded_pairs AS (
                            SELECT DISTINCT
                                least(relationship.source_id, relationship.target_id) AS pair_source_id,
                                greatest(relationship.source_id, relationship.target_id) AS pair_target_id
                            FROM relationships relationship
                            WHERE relationship.graph_id = ${input.graphId}
                              AND relationship.id = ANY(${relationshipIds})
                        ), duplicates AS (
                            SELECT
                                relationship.id,
                                first_value(relationship.id) OVER (
                                    PARTITION BY relationship.graph_id, least(relationship.source_id, relationship.target_id), greatest(relationship.source_id, relationship.target_id)
                                    ORDER BY relationship.active DESC, relationship.id ASC
                                ) AS canonical_id
                            FROM relationships relationship
                            JOIN seeded_pairs seeded
                              ON seeded.pair_source_id = least(relationship.source_id, relationship.target_id)
                             AND seeded.pair_target_id = greatest(relationship.source_id, relationship.target_id)
                            WHERE relationship.graph_id = ${input.graphId}
                        )
                        DELETE FROM relationships relationship
                        USING duplicates
                        WHERE relationship.id = duplicates.id
                          AND duplicates.id <> duplicates.canonical_id
                    `);
                    }
                    const dedupeRelationshipsDuration = performance.now() - dedupeRelationshipsStart;

                    return {
                        insertUnitsDuration,
                        insertEntitiesDuration,
                        insertRelationshipsDuration,
                        dedupeEntitiesDuration,
                        dedupeRelationshipsDuration,
                    };
                });

                const duration = performance.now() - start;

                return {
                    graphKey: graphResult.key,
                    duration,
                    metrics,
                };
            });
            if (saveGraphResult === FILE_DELETED) {
                return;
            }

            const statsResult = await step.run({ name: "store-process-stats" }, async () => {
                if (await stopIfFileDeleted(input.fileId)) {
                    return FILE_DELETED;
                }

                await db.insert(processStatsTable).values({
                    totalTime:
                        baseFile.duration + unitsResult.duration + graphResult.duration + saveGraphResult.duration,
                    files: 1,
                    fileSizes: fileData.size,
                    fileType: fileData.type,
                    tokenCount: baseFile.tokenCount,
                });
            });
            if (statsResult === FILE_DELETED) {
                return;
            }

            await step.run({ name: "mark-file-complete" }, async () => {
                await updateFileProcessingState(input.fileId, "completed", "processed");
            });

            return saveGraphResult.graphKey;
        } catch (error) {
            if (run.retryTerminal) {
                await updateFileProcessingState(input.fileId, "failed", "failed");
            }

            throw workflowError(error);
        }
    }
);
