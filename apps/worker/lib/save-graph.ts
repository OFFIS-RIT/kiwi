import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { entityTable, filesTable, relationshipTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { currentSourceSql, unexpiredSourcePredicate, visibleFilePredicate, visibleFileSql } from "@kiwi/db/source-validity";
import type { Graph } from "@kiwi/graph";
import { eq, sql, and } from "drizzle-orm";
import { chunkItems } from "./chunk";
import { EMPTY_VECTOR_SQL, entityCompactNameKey, textArray } from "./sql";
import { toTextUnitRows } from "./text-unit-rows";

const DEFAULT_RELATIONSHIP_KIND = "RELATED";

type GraphSaveTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type GraphSaveResult = {
    summary: {
        units: number;
        entities: number;
        relationships: number;
    };
    duration: number;
    metrics: {
        insertUnitsDuration: number;
        insertEntitiesDuration: number;
        insertRelationshipsDuration: number;
        dedupeEntitiesDuration: number;
        dedupeRelationshipsDuration: number;
        invalidateStaleSourcesDuration: number;
    };
};

export function collectPendingDescriptionTargets(graphId: string): Effect.Effect<{ entityIds: string[]; relationshipIds: string[] }, unknown> {
    return Effect.tryPromise(async () => {
    const newEntities = await db
        .select({ id: entityTable.id, name: entityTable.name })
        .from(entityTable)
        .where(and(eq(entityTable.graphId, graphId), eq(entityTable.active, false)));

    const updatedEntityRows = await db
        .selectDistinct({
            id: entityTable.id,
            name: entityTable.name,
            description: entityTable.description,
        })
        .from(entityTable)
        .innerJoin(sourcesTable, eq(sourcesTable.entityId, entityTable.id))
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
        .where(
            and(
                eq(entityTable.graphId, graphId),
                eq(entityTable.active, true),
                eq(sourcesTable.active, false),
                unexpiredSourcePredicate(sourcesTable),
                visibleFilePredicate(filesTable)
            )
        );
    const updatedEntities = Array.from(new Map(updatedEntityRows.map((entity) => [entity.id, entity])).values());

    const newRelationships = await db
        .select({ id: relationshipTable.id, sourceId: relationshipTable.sourceId, targetId: relationshipTable.targetId })
        .from(relationshipTable)
        .where(and(eq(relationshipTable.graphId, graphId), eq(relationshipTable.active, false)));

    const updatedRelationshipRows = await db
        .selectDistinct({
            id: relationshipTable.id,
            sourceId: relationshipTable.sourceId,
            targetId: relationshipTable.targetId,
            description: relationshipTable.description,
        })
        .from(relationshipTable)
        .innerJoin(sourcesTable, eq(sourcesTable.relationshipId, relationshipTable.id))
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
        .where(
            and(
                eq(relationshipTable.graphId, graphId),
                eq(relationshipTable.active, true),
                eq(sourcesTable.active, false),
                unexpiredSourcePredicate(sourcesTable),
                visibleFilePredicate(filesTable)
            )
        );
    const updatedRelationships = Array.from(
        new Map(updatedRelationshipRows.map((relationship) => [relationship.id, relationship])).values()
    );

        return {
            entityIds: [...newEntities.map((entity) => entity.id), ...updatedEntities.map((entity) => entity.id)],
            relationshipIds: [
                ...newRelationships.map((relationship) => relationship.id),
                ...updatedRelationships.map((relationship) => relationship.id),
            ],
        };
    });
}

export function saveGraphToDatabase(graphId: string, graph: Graph): Effect.Effect<GraphSaveResult, unknown> {
    return Effect.tryPromise(async () => {
        const start = performance.now();
        const rows = buildGraphRows(graphId, graph);
        const metrics = await db.transaction(async (tx) =>
            Effect.runPromise(
                Effect.gen(function* () {
                    const insertMetrics = yield* insertGraphRows(tx, rows);
                    const dedupeEntitiesDuration = yield* measureDuration(
                        dedupeEntityRows(tx, graphId, rows.insertedEntityIds)
                    );
                    const dedupeRelationshipsDuration = yield* measureDuration(
                        dedupeRelationshipRows(tx, graphId, rows.insertedRelationshipIds)
                    );
                    const invalidateStaleSourcesDuration = yield* measureDuration(
                        invalidateStaleCurrentCodeSources(tx, graphId, rows.insertedSourceIds)
                    );

                    return {
                        ...insertMetrics,
                        dedupeEntitiesDuration,
                        dedupeRelationshipsDuration,
                        invalidateStaleSourcesDuration,
                    };
                })
            )
        );

        return {
            summary: {
                units: graph.units.length,
                entities: graph.entities.length,
                relationships: graph.relationships.length,
            },
            duration: performance.now() - start,
            metrics,
        };
    });
}

function buildGraphRows(graphId: string, graph: Graph) {
    const unitRows = toTextUnitRows(graph.units);
    const entityRows = graph.entities.map((entity) => ({
        id: entity.id,
        graphId,
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
                sourceChunkIds: source.sourceChunkIds ?? [],
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
                sourceChunkIds: source.sourceChunkIds ?? [],
                embedding: EMPTY_VECTOR_SQL,
            }))
        ),
    ];
    const relationshipRows = graph.relationships.map((relationship) => ({
        id: relationship.id,
        active: false,
        sourceId: relationship.sourceId,
        targetId: relationship.targetId,
        graphId,
        kind: relationship.kind ?? DEFAULT_RELATIONSHIP_KIND,
        directed: relationship.directed === true,
        rank: relationship.strength,
        description: "",
        embedding: EMPTY_VECTOR_SQL,
    }));

    const insertedEntityIds = entityRows.map((entity) => entity.id);
    const insertedRelationshipIds = relationshipRows.map((relationship) => relationship.id);
    const insertedSourceIds = sourceRows.map((source) => source.id);

    return { unitRows, entityRows, relationshipRows, sourceRows, insertedEntityIds, insertedRelationshipIds, insertedSourceIds };
}

function measureDuration(work: Effect.Effect<void, unknown>): Effect.Effect<number, unknown> {
    return Effect.gen(function* () {
        const start = performance.now();
        yield* work;
        return performance.now() - start;
    });
}

function insertGraphRows(
    tx: GraphSaveTransaction,
    rows: ReturnType<typeof buildGraphRows>
): Effect.Effect<
    {
        insertUnitsDuration: number;
        insertEntitiesDuration: number;
        insertRelationshipsDuration: number;
    },
    unknown
> {
    return Effect.gen(function* () {
        const insertUnitsDuration = yield* measureDuration(
            Effect.tryPromise(async () => {
                for (const chunk of chunkItems(rows.unitRows)) {
                    await tx
                        .insert(textUnitTable)
                        .values(chunk)
                        .onConflictDoUpdate({
                            target: textUnitTable.id,
                            set: {
                                fileId: sql`excluded.file_id`,
                                text: sql`excluded.text`,
                                startPage: sql`excluded.start_page`,
                                endPage: sql`excluded.end_page`,
                                chunks: sql`excluded.chunks`,
                                updatedAt: sql`NOW()`,
                            },
                        });
                }
            })
        );

        const insertEntitiesDuration = yield* measureDuration(
            Effect.tryPromise(async () => {
                for (const chunk of chunkItems(rows.entityRows)) {
                    await tx.insert(entityTable).values(chunk).onConflictDoNothing();
                }
            })
        );

        const insertRelationshipsDuration = yield* measureDuration(
            Effect.tryPromise(async () => {
                for (const chunk of chunkItems(rows.relationshipRows)) {
                    await tx.insert(relationshipTable).values(chunk).onConflictDoNothing();
                }
                for (const chunk of chunkItems(rows.sourceRows)) {
                    await tx.insert(sourcesTable).values(chunk).onConflictDoNothing();
                }
            })
        );

        return { insertUnitsDuration, insertEntitiesDuration, insertRelationshipsDuration };
    });
}

function dedupeEntityRows(
    tx: GraphSaveTransaction,
    graphId: string,
    insertedEntityIds: string[]
): Effect.Effect<void, unknown> {
    if (insertedEntityIds.length === 0) {
        return Effect.succeed(undefined);
    }

    return Effect.tryPromise(async () => {

    const entityIds = textArray(insertedEntityIds);
    const candidateNameKeySql = sql.raw(entityCompactNameKey("candidate.name"));
    const seededNameKeySql = sql.raw(entityCompactNameKey("seed.name"));

    await tx.execute(sql`
                WITH seeded_keys AS (
                    SELECT DISTINCT seed.type, ${seededNameKeySql} AS normalized_name
                    FROM entities seed
                    WHERE seed.graph_id = ${graphId}
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
                    WHERE candidate.graph_id = ${graphId}
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
                    WHERE seed.graph_id = ${graphId}
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
                    WHERE candidate.graph_id = ${graphId}
                )
                UPDATE relationships relationship
                SET source_id = duplicates.canonical_id
                FROM duplicates
                WHERE relationship.source_id = duplicates.id
                  AND relationship.graph_id = ${graphId}
                  AND duplicates.id <> duplicates.canonical_id
            `);

    await tx.execute(sql`
                WITH seeded_keys AS (
                    SELECT DISTINCT seed.type, ${seededNameKeySql} AS normalized_name
                    FROM entities seed
                    WHERE seed.graph_id = ${graphId}
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
                    WHERE candidate.graph_id = ${graphId}
                )
                UPDATE relationships relationship
                SET target_id = duplicates.canonical_id
                FROM duplicates
                WHERE relationship.target_id = duplicates.id
                  AND relationship.graph_id = ${graphId}
                  AND duplicates.id <> duplicates.canonical_id
            `);

    await tx.execute(sql`
                WITH seeded_keys AS (
                    SELECT DISTINCT seed.type, ${seededNameKeySql} AS normalized_name
                    FROM entities seed
                    WHERE seed.graph_id = ${graphId}
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
                    WHERE candidate.graph_id = ${graphId}
                )
                DELETE FROM entities entity
                USING duplicates
                WHERE entity.id = duplicates.id
                  AND duplicates.id <> duplicates.canonical_id
            `);
    });
}

function dedupeRelationshipRows(
    tx: GraphSaveTransaction,
    graphId: string,
    insertedRelationshipIds: string[]
): Effect.Effect<void, unknown> {
    return Effect.tryPromise(async () => {
    await tx.execute(sql`
            DELETE FROM relationships
            WHERE graph_id = ${graphId}
              AND directed = false
              AND source_id = target_id
        `);

    if (insertedRelationshipIds.length === 0) {
        return;
    }

    const relationshipIds = textArray(insertedRelationshipIds);

    await tx.execute(sql`
                WITH seeded_pairs AS (
                    SELECT DISTINCT
                        relationship.kind,
                        relationship.directed,
                        CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END AS pair_source_id,
                        CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END AS pair_target_id
                    FROM relationships relationship
                    WHERE relationship.graph_id = ${graphId}
                      AND relationship.id = ANY(${relationshipIds})
                ), duplicates AS (
                    SELECT
                        relationship.id,
                        CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END AS canonical_source_id,
                        CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END AS canonical_target_id,
                        first_value(relationship.id) OVER (
                            PARTITION BY relationship.graph_id,
                                relationship.kind,
                                relationship.directed,
                                CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END,
                                CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END
                            ORDER BY relationship.active DESC, relationship.id ASC
                        ) AS canonical_id,
                        max(relationship.rank) OVER (
                            PARTITION BY relationship.graph_id,
                                relationship.kind,
                                relationship.directed,
                                CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END,
                                CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END
                        ) AS canonical_rank
                    FROM relationships relationship
                    JOIN seeded_pairs seeded
                      ON seeded.kind = relationship.kind
                     AND seeded.directed = relationship.directed
                     AND seeded.pair_source_id = CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END
                     AND seeded.pair_target_id = CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END
                    WHERE relationship.graph_id = ${graphId}
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
                        relationship.kind,
                        relationship.directed,
                        CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END AS pair_source_id,
                        CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END AS pair_target_id
                    FROM relationships relationship
                    WHERE relationship.graph_id = ${graphId}
                      AND relationship.id = ANY(${relationshipIds})
                ), duplicates AS (
                    SELECT
                        relationship.id,
                        first_value(relationship.id) OVER (
                            PARTITION BY relationship.graph_id,
                                relationship.kind,
                                relationship.directed,
                                CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END,
                                CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END
                            ORDER BY relationship.active DESC, relationship.id ASC
                        ) AS canonical_id
                    FROM relationships relationship
                    JOIN seeded_pairs seeded
                      ON seeded.kind = relationship.kind
                     AND seeded.directed = relationship.directed
                     AND seeded.pair_source_id = CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END
                     AND seeded.pair_target_id = CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END
                    WHERE relationship.graph_id = ${graphId}
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
                        relationship.kind,
                        relationship.directed,
                        CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END AS pair_source_id,
                        CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END AS pair_target_id
                    FROM relationships relationship
                    WHERE relationship.graph_id = ${graphId}
                      AND relationship.id = ANY(${relationshipIds})
                ), duplicates AS (
                    SELECT
                        relationship.id,
                        first_value(relationship.id) OVER (
                            PARTITION BY relationship.graph_id,
                                relationship.kind,
                                relationship.directed,
                                CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END,
                                CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END
                            ORDER BY relationship.active DESC, relationship.id ASC
                        ) AS canonical_id
                    FROM relationships relationship
                    JOIN seeded_pairs seeded
                      ON seeded.kind = relationship.kind
                     AND seeded.directed = relationship.directed
                     AND seeded.pair_source_id = CASE WHEN relationship.directed THEN relationship.source_id ELSE least(relationship.source_id, relationship.target_id) END
                     AND seeded.pair_target_id = CASE WHEN relationship.directed THEN relationship.target_id ELSE greatest(relationship.source_id, relationship.target_id) END
                    WHERE relationship.graph_id = ${graphId}
                )
                DELETE FROM relationships relationship
                USING duplicates
                WHERE relationship.id = duplicates.id
                  AND duplicates.id <> duplicates.canonical_id
            `);
    });
}

function invalidateStaleCurrentCodeSources(
    tx: GraphSaveTransaction,
    graphId: string,
    insertedSourceIds: string[]
): Effect.Effect<void, unknown> {
    if (insertedSourceIds.length === 0) {
        return Effect.succeed(undefined);
    }

    return Effect.tryPromise(async () => {

    const sourceIds = textArray(insertedSourceIds);

    await tx.execute(sql`
        WITH new_code_sources AS (
            SELECT DISTINCT source.id, source.entity_id, source.relationship_id
            FROM sources source
            INNER JOIN text_units text_unit ON text_unit.id = source.text_unit_id
            INNER JOIN files file ON file.id = text_unit.file_id
            WHERE source.id = ANY(${sourceIds})
              AND source.valid_until IS NULL
              AND file.graph_id = ${graphId}
              AND ${visibleFileSql("file")}
              AND file.file_type = 'code'
        ), stale_sources AS (
            SELECT old_source.id
            FROM sources old_source
            INNER JOIN text_units old_text_unit ON old_text_unit.id = old_source.text_unit_id
            INNER JOIN files old_file ON old_file.id = old_text_unit.file_id
            INNER JOIN new_code_sources new_source
              ON (
                  new_source.entity_id IS NOT NULL
                  AND old_source.entity_id = new_source.entity_id
              )
              OR (
                  new_source.relationship_id IS NOT NULL
                  AND old_source.relationship_id = new_source.relationship_id
              )
            WHERE ${currentSourceSql("old_source")}
              AND ${visibleFileSql("old_file")}
              AND old_file.graph_id = ${graphId}
              AND old_file.file_type = 'code'
              AND old_source.id <> ALL(${sourceIds})
        )
        UPDATE sources source
        SET valid_until = NOW(),
            updated_at = NOW()
        FROM stale_sources
        WHERE source.id = stale_sources.id
    `);
    });
}
