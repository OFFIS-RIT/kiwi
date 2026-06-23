import * as Effect from "effect/Effect";
import type { DatabaseTransaction } from "@kiwi/db/effect";
import { withWorkerDb, withWorkerDbVoid, type WorkerServices } from "../runtime/effect";
import { entityTable, filesTable, relationshipTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { unexpiredSourcePredicate, visibleFilePredicate } from "@kiwi/db/source-validity";
import { and, eq, inArray, isNotNull, sql } from "@kiwi/db/drizzle";
import { textArray } from "../db/sql";
import { embed, embedMany } from "ai";
import { withAiSlot } from "@kiwi/ai";
import { buildDescription } from "./build";
import { createWorkerClient } from "../ai/client";
import { chunkItems } from "../collections/chunk";
import { DESCRIPTION_BATCH_SIZE } from "./workflow";

type SourceEmbeddingUpdate = {
    id: string;
    embedding: number[];
};

type DescriptionUpdate = {
    id: string;
    description: string;
    embedding: number[];
    sourceEmbeddings: SourceEmbeddingUpdate[];
};

type DescriptionGenerationResult = { type: "deactivate"; id: string } | { type: "update"; update: DescriptionUpdate };

type DescriptionPersistenceBatch = {
    updates: DescriptionUpdate[];
    deactivateIds: string[];
};

type DescriptionClient = Effect.Success<ReturnType<typeof createWorkerClient>>;

type DescriptionSource = {
    id: string;
    description: string;
};

type DescriptionItem = {
    id: string;
    name: string;
    description: string;
    sources: DescriptionSource[];
};

export function createDescriptionClient(graphId: string): Effect.Effect<DescriptionClient, unknown, WorkerServices> {
    return createWorkerClient(graphId);
}

export const updateSourceEmbeddingsBatch = Effect.fn("updateSourceEmbeddingsBatch")(function* (
    tx: Pick<DatabaseTransaction, "execute">,
    updates: SourceEmbeddingUpdate[]
) {
    if (updates.length === 0) {
        return;
    }

    yield* tx.execute(sql`
        UPDATE sources AS source
        SET embedding = batch.embedding::vector,
            active = true
        FROM (
            VALUES ${sql.join(
                updates.map((update) => sql`(${update.id}, ${JSON.stringify(update.embedding)})`),
                sql`, `
            )}
        ) AS batch(id, embedding)
        WHERE source.id = batch.id
          AND source.valid_until IS NULL
    `);
});

const updateEntityDescriptionsBatch = Effect.fn("updateEntityDescriptionsBatch")(function* (
    tx: Pick<DatabaseTransaction, "execute">,
    updates: DescriptionUpdate[]
) {
    if (updates.length === 0) {
        return;
    }

    yield* tx.execute(sql`
        UPDATE entities AS entity
        SET description = batch.description,
            embedding = batch.embedding::vector,
            active = true,
            updated_at = NOW()
        FROM (
            VALUES ${sql.join(
                updates.map(
                    (update) => sql`(${update.id}, ${update.description}, ${JSON.stringify(update.embedding)})`
                ),
                sql`, `
            )}
        ) AS batch(id, description, embedding)
        WHERE entity.id = batch.id
    `);
});

const updateRelationshipDescriptionsBatch = Effect.fn("updateRelationshipDescriptionsBatch")(function* (
    tx: Pick<DatabaseTransaction, "execute">,
    updates: DescriptionUpdate[]
) {
    if (updates.length === 0) {
        return;
    }

    yield* tx.execute(sql`
        UPDATE relationships AS relationship
        SET description = batch.description,
            embedding = batch.embedding::vector,
            active = true,
            updated_at = NOW()
        FROM (
            VALUES ${sql.join(
                updates.map(
                    (update) => sql`(${update.id}, ${update.description}, ${JSON.stringify(update.embedding)})`
                ),
                sql`, `
            )}
        ) AS batch(id, description, embedding)
        WHERE relationship.id = batch.id
    `);
});

const deactivateEntitiesBatch = Effect.fn("deactivateEntitiesBatch")(function* (
    tx: Pick<DatabaseTransaction, "execute">,
    ids: string[]
) {
    if (ids.length === 0) {
        return;
    }

    yield* tx.execute(sql`
        UPDATE entities
        SET active = false,
            updated_at = NOW()
        WHERE id = ANY(${textArray(ids)})
    `);
});

const deactivateRelationshipsBatch = Effect.fn("deactivateRelationshipsBatch")(function* (
    tx: Pick<DatabaseTransaction, "execute">,
    ids: string[]
) {
    if (ids.length === 0) {
        return;
    }

    yield* tx.execute(sql`
        UPDATE relationships
        SET active = false,
            updated_at = NOW()
        WHERE id = ANY(${textArray(ids)})
    `);
});

function groupSources<T extends { id: string; description: string }, TKey extends string | null | undefined>(
    rows: T[],
    getKey: (row: T) => TKey
) {
    const grouped = new Map<string, DescriptionSource[]>();

    for (const row of rows) {
        const key = getKey(row);
        if (!key) {
            continue;
        }

        let group = grouped.get(key);
        if (!group) {
            group = [];
            grouped.set(key, group);
        }

        group.push({ id: row.id, description: row.description });
    }

    return grouped;
}

const generateDescriptionUpdate = Effect.fn("generateDescriptionUpdate")(function* (
    item: DescriptionItem,
    client: DescriptionClient
): Effect.fn.Return<DescriptionGenerationResult, unknown> {
    if (item.sources.length === 0) {
        return { type: "deactivate", id: item.id };
    }

    const sourceDescriptions = item.sources.map((source) => source.description);
    const description = yield* buildDescription(client.text, item.name, sourceDescriptions, item.description);

    const { embedding } = yield* Effect.tryPromise(() =>
        withAiSlot("embedding", (signal) =>
            embed({
                model: client.embedding,
                value: description,
                abortSignal: signal,
            })
        )
    );

    const { embeddings: sourceEmbeddings } = yield* Effect.tryPromise(() =>
        withAiSlot("embedding", (signal) =>
            embedMany({
                model: client.embedding,
                values: sourceDescriptions,
                abortSignal: signal,
            })
        )
    );

    return {
        type: "update",
        update: {
            id: item.id,
            description,
            embedding,
            sourceEmbeddings: item.sources.map((source, index) => ({
                id: source.id,
                embedding: sourceEmbeddings[index]!,
            })),
        },
    };
});

function collectDescriptionPersistenceBatch(results: DescriptionGenerationResult[]): DescriptionPersistenceBatch {
    const updates: DescriptionUpdate[] = [];
    const deactivateIds: string[] = [];

    for (const result of results) {
        if (result.type === "update") {
            updates.push(result.update);
        } else {
            deactivateIds.push(result.id);
        }
    }

    return { updates, deactivateIds };
}

function regenerateDescriptions<R>(
    items: DescriptionItem[],
    client: DescriptionClient,
    persistBatch: (batch: DescriptionPersistenceBatch) => Effect.Effect<void, unknown, R>
): Effect.Effect<void, unknown, R> {
    return Effect.gen(function* () {
        for (const chunk of chunkItems(items, DESCRIPTION_BATCH_SIZE)) {
            const results = yield* Effect.all(
                chunk.map((item) => generateDescriptionUpdate(item, client)),
                {
                    concurrency: DESCRIPTION_BATCH_SIZE,
                }
            );

            yield* persistBatch(collectDescriptionPersistenceBatch(results));
        }
    });
}

export function regenerateEntities(
    graphId: string,
    entityIds: string[],
    client?: DescriptionClient
): Effect.Effect<void, unknown, WorkerServices> {
    return Effect.gen(function* () {
        if (entityIds.length === 0) {
            return;
        }
        const descriptionClient = client ?? (yield* createDescriptionClient(graphId));

        const entities = yield* withWorkerDb((db) =>
            db
                .select({ id: entityTable.id, name: entityTable.name, description: entityTable.description })
                .from(entityTable)
                .where(and(eq(entityTable.graphId, graphId), inArray(entityTable.id, entityIds)))
        );

        if (entities.length === 0) {
            return;
        }

        const sources = yield* withWorkerDb((db) =>
            db
                .select({
                    id: sourcesTable.id,
                    entityId: sourcesTable.entityId,
                    description: sourcesTable.description,
                })
                .from(sourcesTable)
                .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
                .where(
                    and(
                        inArray(
                            sourcesTable.entityId,
                            entities.map((entity) => entity.id)
                        ),
                        isNotNull(sourcesTable.entityId),
                        unexpiredSourcePredicate(sourcesTable),
                        visibleFilePredicate(filesTable)
                    )
                )
        );

        const sourcesByEntity = groupSources(sources, (source) => source.entityId);

        yield* regenerateDescriptions(
            entities.map((entity) => ({
                id: entity.id,
                name: entity.name,
                description: entity.description,
                sources: sourcesByEntity.get(entity.id) ?? [],
            })),
            descriptionClient,
            Effect.fn("regenerateEntities.persistBatch")(function* ({
                updates,
                deactivateIds,
            }: DescriptionPersistenceBatch) {
                yield* withWorkerDbVoid((db) =>
                    db.transaction((tx) =>
                        Effect.gen(function* () {
                            yield* updateEntityDescriptionsBatch(tx, updates);
                            yield* deactivateEntitiesBatch(tx, deactivateIds);
                            yield* updateSourceEmbeddingsBatch(
                                tx,
                                updates.flatMap((update) => update.sourceEmbeddings)
                            );
                        })
                    )
                );
            })
        );
    });
}

export function regenerateRelationships(
    graphId: string,
    relationshipIds: string[],
    client?: DescriptionClient
): Effect.Effect<void, unknown, WorkerServices> {
    return Effect.gen(function* () {
        if (relationshipIds.length === 0) {
            return;
        }
        const descriptionClient = client ?? (yield* createDescriptionClient(graphId));

        const relationships = yield* withWorkerDb((db) =>
            db
                .select({
                    id: relationshipTable.id,
                    sourceId: relationshipTable.sourceId,
                    targetId: relationshipTable.targetId,
                    description: relationshipTable.description,
                })
                .from(relationshipTable)
                .where(and(eq(relationshipTable.graphId, graphId), inArray(relationshipTable.id, relationshipIds)))
        );

        if (relationships.length === 0) {
            return;
        }

        const relationshipSources = yield* withWorkerDb((db) =>
            db
                .select({
                    id: sourcesTable.id,
                    relationshipId: sourcesTable.relationshipId,
                    description: sourcesTable.description,
                })
                .from(sourcesTable)
                .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
                .where(
                    and(
                        inArray(
                            sourcesTable.relationshipId,
                            relationships.map((relationship) => relationship.id)
                        ),
                        isNotNull(sourcesTable.relationshipId),
                        unexpiredSourcePredicate(sourcesTable),
                        visibleFilePredicate(filesTable)
                    )
                )
        );

        const relationshipSourcesById = groupSources(relationshipSources, (source) => source.relationshipId);

        const entityIds = [
            ...new Set(relationships.flatMap((relationship) => [relationship.sourceId, relationship.targetId])),
        ];
        const entityNames =
            entityIds.length > 0
                ? yield* withWorkerDb((db) =>
                      db
                          .select({ id: entityTable.id, name: entityTable.name })
                          .from(entityTable)
                          .where(inArray(entityTable.id, entityIds))
                  )
                : [];
        const entityNameMap = new Map(entityNames.map((entity) => [entity.id, entity.name]));

        yield* regenerateDescriptions(
            relationships.map((relationship) => ({
                id: relationship.id,
                name: `${entityNameMap.get(relationship.sourceId) || "Unknown"} -> ${entityNameMap.get(relationship.targetId) || "Unknown"}`,
                description: relationship.description,
                sources: relationshipSourcesById.get(relationship.id) ?? [],
            })),
            descriptionClient,
            Effect.fn("regenerateRelationships.persistBatch")(function* ({
                updates,
                deactivateIds,
            }: DescriptionPersistenceBatch) {
                yield* withWorkerDbVoid((db) =>
                    db.transaction((tx) =>
                        Effect.gen(function* () {
                            yield* updateRelationshipDescriptionsBatch(tx, updates);
                            yield* deactivateRelationshipsBatch(tx, deactivateIds);
                            yield* updateSourceEmbeddingsBatch(
                                tx,
                                updates.flatMap((update) => update.sourceEmbeddings)
                            );
                        })
                    )
                );
            })
        );
    });
}
