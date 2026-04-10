import { db } from "@kiwi/db";
import {
    entityTable,
    filesTable,
    graphTable,
    processStatsTable,
    relationshipTable,
    sourcesTable,
    textUnitTable,
} from "@kiwi/db/tables/graph";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
import { buildDescription } from "../lib/description";
import { ExcelLoader } from "@kiwi/graph/loader/excel";
import { PPTXLoader } from "@kiwi/graph/loader/ppt";
import { getFile, putNamedFile } from "@kiwi/files";
import { buildAdapter, buildEmbeddingAdapter } from "../lib/ai";
import { EMPTY_VECTOR_SQL, normalizedEntityName, textArray } from "../lib/sql";
import { chunkItems } from "../lib/chunk";
import { embedMany } from "ai";
import { processFilesSpec } from "./process-files-spec";
import { getDerivedFilePrefix, getDerivedImagePrefix } from "../lib/derived-files";
import { buildPDFLoaderOptions } from "../lib/pdf-loader";
import { buildMetadata, buildMetadataExcerpt } from "../lib/metadata";

const WORKFLOW_STORAGE_VERSION = "v1";

export const processFiles = defineWorkflow(processFilesSpec, async ({ input, step }) => {
    // Update project status
    await step.run({ name: "update-project-status" }, async () => {
        await db.update(graphTable).set({ state: "updating" }).where(eq(graphTable.id, input.graphId));
    });

    // Process individual files in parallel
    const promises = [];
    for (const file of input.fileIds) {
        promises.push(step.runWorkflow(processFile.spec, { graphId: input.graphId, fileId: file }));
    }
    await Promise.all(promises);

    // Run description generation after all files are processed for new graph entries
    await step.run({ name: "generate-descriptions" }, async () => {
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
        });

        if (!client.text || !client.embedding) {
            throw new Error("Text and embedding adapters are required for description generation");
        }

        // New entities (active=false)
        const newEntities = await db
            .select({ id: entityTable.id, name: entityTable.name })
            .from(entityTable)
            .where(and(eq(entityTable.graphId, input.graphId), eq(entityTable.active, false)));

        // Updated entities (active=true with inactive sources)
        const updatedEntitiesRaw = await db
            .selectDistinct({ id: entityTable.id, name: entityTable.name, description: entityTable.description })
            .from(entityTable)
            .innerJoin(sourcesTable, eq(sourcesTable.entityId, entityTable.id))
            .where(
                and(
                    eq(entityTable.graphId, input.graphId),
                    eq(entityTable.active, true),
                    eq(sourcesTable.active, false)
                )
            );
        const updatedEntitiesMap = new Map(updatedEntitiesRaw.map((e) => [e.id, e]));
        const updatedEntities = Array.from(updatedEntitiesMap.values());

        const entityIdsToProcess = [...newEntities.map((e) => e.id), ...updatedEntities.map((e) => e.id)];

        if (entityIdsToProcess.length > 0) {
            // Load inactive sources for all entities that need processing
            const inactiveSources = await db
                .select({
                    id: sourcesTable.id,
                    entityId: sourcesTable.entityId,
                    description: sourcesTable.description,
                })
                .from(sourcesTable)
                .where(
                    and(
                        inArray(sourcesTable.entityId, entityIdsToProcess),
                        eq(sourcesTable.active, false),
                        isNotNull(sourcesTable.entityId)
                    )
                );

            const sourcesByEntity = new Map<string, typeof inactiveSources>();
            for (const source of inactiveSources) {
                if (!source.entityId) {
                    continue;
                }

                let group = sourcesByEntity.get(source.entityId);
                if (!group) {
                    group = [];
                    sourcesByEntity.set(source.entityId, group);
                }
                group.push(source);
            }

            type EntityItem = { id: string; name: string; currentDescription?: string };
            const entityItems: EntityItem[] = [
                ...newEntities.map((e) => ({ id: e.id, name: e.name })),
                ...updatedEntities.map((e) => ({ id: e.id, name: e.name, currentDescription: e.description })),
            ];

            type DescResult = {
                id: string;
                description: string;
                sourceIds: string[];
                sourceDescriptions: string[];
            };
            const entityResults: DescResult[] = [];

            for (const chunk of chunkItems(entityItems, 100)) {
                const chunkResults = await Promise.all(
                    chunk.map(async (entity): Promise<DescResult | null> => {
                        const sources = sourcesByEntity.get(entity.id) || [];
                        if (sources.length === 0) return null;

                        const sourceDescs = sources.map((s) => s.description);
                        const description = await buildDescription(
                            client.text!,
                            entity.name,
                            sourceDescs,
                            entity.currentDescription
                        );

                        return {
                            id: entity.id,
                            description,
                            sourceIds: sources.map((s) => s.id),
                            sourceDescriptions: sources.map((s) => s.description),
                        };
                    })
                );
                entityResults.push(...chunkResults.filter((r): r is DescResult => r !== null));
            }

            if (entityResults.length > 0) {
                const { embeddings: entityEmbeddings } = await embedMany({
                    model: client.embedding!,
                    values: entityResults.map((r) => r.description),
                });

                const allSourceDescs = entityResults.flatMap((r) => r.sourceDescriptions);
                const allSourceIds = entityResults.flatMap((r) => r.sourceIds);
                const { embeddings: sourceEmbeddings } = await embedMany({
                    model: client.embedding!,
                    values: allSourceDescs,
                });

                await db.transaction(async (tx) => {
                    for (let i = 0; i < entityResults.length; i++) {
                        const result = entityResults[i]!;
                        await tx
                            .update(entityTable)
                            .set({
                                description: result.description,
                                embedding: entityEmbeddings[i]!,
                                active: true,
                            })
                            .where(eq(entityTable.id, result.id));
                    }

                    for (let i = 0; i < allSourceIds.length; i++) {
                        await tx
                            .update(sourcesTable)
                            .set({
                                embedding: sourceEmbeddings[i]!,
                                active: true,
                            })
                            .where(eq(sourcesTable.id, allSourceIds[i]!));
                    }
                });
            }
        }

        // New relationships (active=false)
        const newRelationships = await db
            .select({
                id: relationshipTable.id,
                sourceId: relationshipTable.sourceId,
                targetId: relationshipTable.targetId,
            })
            .from(relationshipTable)
            .where(and(eq(relationshipTable.graphId, input.graphId), eq(relationshipTable.active, false)));

        // Updated relationships (active=true with inactive sources)
        const updatedRelsRaw = await db
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
        const updatedRelsMap = new Map(updatedRelsRaw.map((r) => [r.id, r]));
        const updatedRelationships = Array.from(updatedRelsMap.values());

        const relIdsToProcess = [...newRelationships.map((r) => r.id), ...updatedRelationships.map((r) => r.id)];

        if (relIdsToProcess.length > 0) {
            // Get entity names for source/target labels
            const relEntityIds = [
                ...new Set([
                    ...newRelationships.flatMap((r) => [r.sourceId, r.targetId]),
                    ...updatedRelationships.flatMap((r) => [r.sourceId, r.targetId]),
                ]),
            ];
            const entityNameRows =
                relEntityIds.length > 0
                    ? await db
                          .select({ id: entityTable.id, name: entityTable.name })
                          .from(entityTable)
                          .where(inArray(entityTable.id, relEntityIds))
                    : [];
            const entityNameMap = new Map(entityNameRows.map((e) => [e.id, e.name]));

            // Load inactive relationship sources
            const inactiveRelSources = await db
                .select({
                    id: sourcesTable.id,
                    relationshipId: sourcesTable.relationshipId,
                    description: sourcesTable.description,
                })
                .from(sourcesTable)
                .where(
                    and(
                        inArray(sourcesTable.relationshipId, relIdsToProcess),
                        eq(sourcesTable.active, false),
                        isNotNull(sourcesTable.relationshipId)
                    )
                );

            const relSourcesByRel = new Map<string, typeof inactiveRelSources>();
            for (const source of inactiveRelSources) {
                if (!source.relationshipId) {
                    continue;
                }

                let group = relSourcesByRel.get(source.relationshipId);
                if (!group) {
                    group = [];
                    relSourcesByRel.set(source.relationshipId, group);
                }
                group.push(source);
            }

            type RelItem = { id: string; sourceId: string; targetId: string; currentDescription?: string };
            const relItems: RelItem[] = [
                ...newRelationships.map((r) => ({ id: r.id, sourceId: r.sourceId, targetId: r.targetId })),
                ...updatedRelationships.map((r) => ({
                    id: r.id,
                    sourceId: r.sourceId,
                    targetId: r.targetId,
                    currentDescription: r.description,
                })),
            ];

            type RelResult = { id: string; description: string; sourceIds: string[]; sourceDescriptions: string[] };
            const relResults: RelResult[] = [];

            for (const chunk of chunkItems(relItems, 100)) {
                const chunkResults = await Promise.all(
                    chunk.map(async (rel): Promise<RelResult | null> => {
                        const sources = relSourcesByRel.get(rel.id) || [];
                        if (sources.length === 0) return null;

                        const sourceDescs = sources.map((s) => s.description);
                        const sourceName = entityNameMap.get(rel.sourceId) || "Unknown";
                        const targetName = entityNameMap.get(rel.targetId) || "Unknown";
                        const relName = `${sourceName} -> ${targetName}`;
                        const description = await buildDescription(
                            client.text!,
                            relName,
                            sourceDescs,
                            rel.currentDescription
                        );

                        return {
                            id: rel.id,
                            description,
                            sourceIds: sources.map((s) => s.id),
                            sourceDescriptions: sources.map((s) => s.description),
                        };
                    })
                );
                relResults.push(...chunkResults.filter((r): r is RelResult => r !== null));
            }

            if (relResults.length > 0) {
                const { embeddings: relEmbeddings } = await embedMany({
                    model: client.embedding!,
                    values: relResults.map((r) => r.description),
                });

                const allRelSourceDescs = relResults.flatMap((r) => r.sourceDescriptions);
                const allRelSourceIds = relResults.flatMap((r) => r.sourceIds);
                const { embeddings: relSourceEmbeddings } = await embedMany({
                    model: client.embedding!,
                    values: allRelSourceDescs,
                });

                await db.transaction(async (tx) => {
                    for (let i = 0; i < relResults.length; i++) {
                        const result = relResults[i]!;
                        await tx
                            .update(relationshipTable)
                            .set({
                                description: result.description,
                                embedding: relEmbeddings[i]!,
                                active: true,
                            })
                            .where(eq(relationshipTable.id, result.id));
                    }

                    for (let i = 0; i < allRelSourceIds.length; i++) {
                        await tx
                            .update(sourcesTable)
                            .set({
                                embedding: relSourceEmbeddings[i]!,
                                active: true,
                            })
                            .where(eq(sourcesTable.id, allRelSourceIds[i]!));
                    }
                });
            }
        }
    });

    await step.run({ name: "finalize-project-status" }, async () => {
        await db.update(graphTable).set({ state: "ready" }).where(eq(graphTable.id, input.graphId));
    });
});

export const processFile = defineWorkflow(
    {
        name: "process-file",
        version: "1.0.0",
        retryPolicy: {
            initialInterval: "1s",
            backoffCoefficient: 2,
            maximumInterval: "30s",
        },
        schema: z.object({
            graphId: z.string(),
            fileId: z.string(),
        }),
    },
    async ({ input, step }) => {
        // Get file data from the database
        const [fileData] = await step.run({ name: "get-file-data" }, async () => {
            return db
                .select()
                .from(filesTable)
                .where(and(eq(filesTable.graphId, input.graphId), eq(filesTable.id, input.fileId)))
                .limit(1);
        });
        if (!fileData) {
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

        // Prepocess the file (e.g. save .txt version, count tokens, etc.)
        const baseFile = await step.run({ name: "preprocess-file" }, async () => {
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
                case "pdf":
                    const pdfloader = new PDFLoader(buildPDFLoaderOptions(s3Loader, client.image));
                    loader = pdfloader;
                    break;
                case "doc":
                    if (!client.image) {
                        throw new Error("Image adapter is not configured");
                    }
                    const docxloader = new DOCXLoader({
                        ocr: true,
                        loader: s3Loader,
                        model: client.image,
                        storage: {
                            bucket: env.S3_BUCKET,
                            imagePrefix: derivedImagePrefix,
                        },
                    });
                    loader = docxloader;
                    break;
                case "sheet":
                    const excelLoader = new ExcelLoader({
                        loader: s3Loader,
                    });
                    loader = excelLoader;
                    break;
                case "ppt":
                    if (!client.image) {
                        throw new Error("Image adapter is not configured");
                    }
                    const pptLoader = new PPTXLoader({
                        ocr: true,
                        loader: s3Loader,
                        model: client.image,
                        storage: {
                            bucket: env.S3_BUCKET,
                            imagePrefix: derivedImagePrefix,
                        },
                    });
                    loader = pptLoader;
                    break;
                case "image":
                    if (!client.image) {
                        throw new Error("Image adapter is not configured");
                    }
                    const imageLoader = new ImageLoader({
                        loader: s3Loader,
                        model: client.image,
                    });
                    loader = imageLoader;
                    break;
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

            // For now unused we later track performance with these
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

        const metadataResult = await step.run({ name: "metadata" }, async () => {
            const metadata = await buildMetadata(client.text!, fileData.name, baseFile.metadataExcerpt);

            await db
                .update(filesTable)
                .set({ metadata: metadata || null })
                .where(eq(filesTable.id, input.fileId));

            return {
                metadata,
            };
        });

        const unitsResult = await step.run({ name: "build-units" }, async () => {
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
            const uploadedUnitsFile = await putNamedFile("units.json", JSON.stringify(units), unitsPath, env.S3_BUCKET);

            // For now unused we later track performance with these
            const duration = performance.now() - start;

            return {
                key: uploadedUnitsFile.key,
                duration,
            };
        });

        const graphResult = await step.run({ name: "build-graph" }, async () => {
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
            const uploadedGraphFile = await putNamedFile("graph.json", JSON.stringify(graph), graphPath, env.S3_BUCKET);

            const duration = performance.now() - start;

            return {
                key: uploadedGraphFile.key,
                duration,
            };
        });

        const saveGraphResult = await step.run({ name: "save-graph" }, async () => {
            const start = performance.now();

            const loadedGraph = await getFile<Graph>(graphResult.key, env.S3_BUCKET, "json");
            if (!loadedGraph) {
                throw new Error(`Failed to load graph from ${graphResult.key}`);
            }

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
                    const candidateNameSql = sql.raw(normalizedEntityName("candidate.name"));
                    const seededNameSql = sql.raw(normalizedEntityName("seed.name"));

                    await tx.execute(sql`
                        WITH seeded_keys AS (
                            SELECT DISTINCT seed.type, ${seededNameSql} AS normalized_name
                            FROM entities seed
                            WHERE seed.graph_id = ${input.graphId}
                              AND seed.id = ANY(${entityIds})
                        ), duplicates AS (
                            SELECT
                                candidate.id,
                                first_value(candidate.id) OVER (
                                    PARTITION BY candidate.graph_id, candidate.type, ${candidateNameSql}
                                    ORDER BY candidate.active DESC, candidate.id ASC
                                ) AS canonical_id
                            FROM entities candidate
                            JOIN seeded_keys seeded
                              ON seeded.type = candidate.type
                             AND seeded.normalized_name = ${candidateNameSql}
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
                            SELECT DISTINCT seed.type, ${seededNameSql} AS normalized_name
                            FROM entities seed
                            WHERE seed.graph_id = ${input.graphId}
                              AND seed.id = ANY(${entityIds})
                        ), duplicates AS (
                            SELECT
                                candidate.id,
                                first_value(candidate.id) OVER (
                                    PARTITION BY candidate.graph_id, candidate.type, ${candidateNameSql}
                                    ORDER BY candidate.active DESC, candidate.id ASC
                                ) AS canonical_id
                            FROM entities candidate
                            JOIN seeded_keys seeded
                              ON seeded.type = candidate.type
                             AND seeded.normalized_name = ${candidateNameSql}
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
                            SELECT DISTINCT seed.type, ${seededNameSql} AS normalized_name
                            FROM entities seed
                            WHERE seed.graph_id = ${input.graphId}
                              AND seed.id = ANY(${entityIds})
                        ), duplicates AS (
                            SELECT
                                candidate.id,
                                first_value(candidate.id) OVER (
                                    PARTITION BY candidate.graph_id, candidate.type, ${candidateNameSql}
                                    ORDER BY candidate.active DESC, candidate.id ASC
                                ) AS canonical_id
                            FROM entities candidate
                            JOIN seeded_keys seeded
                              ON seeded.type = candidate.type
                             AND seeded.normalized_name = ${candidateNameSql}
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
                            SELECT DISTINCT seed.type, ${seededNameSql} AS normalized_name
                            FROM entities seed
                            WHERE seed.graph_id = ${input.graphId}
                              AND seed.id = ANY(${entityIds})
                        ), duplicates AS (
                            SELECT
                                candidate.id,
                                first_value(candidate.id) OVER (
                                    PARTITION BY candidate.graph_id, candidate.type, ${candidateNameSql}
                                    ORDER BY candidate.active DESC, candidate.id ASC
                                ) AS canonical_id
                            FROM entities candidate
                            JOIN seeded_keys seeded
                              ON seeded.type = candidate.type
                             AND seeded.normalized_name = ${candidateNameSql}
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

        await step.run({ name: "store-process-stats" }, async () => {
            await db.insert(processStatsTable).values({
                totalTime: baseFile.duration + unitsResult.duration + graphResult.duration + saveGraphResult.duration,
                files: 1,
                fileSizes: fileData.size,
                tokenCount: baseFile.tokenCount,
            });
        });

        return saveGraphResult.graphKey;
    }
);
