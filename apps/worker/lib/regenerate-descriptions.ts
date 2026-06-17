import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { entityTable, filesTable, relationshipTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { unexpiredSourcePredicate, visibleFilePredicate } from "@kiwi/db/source-validity";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { embed, embedMany } from "ai";
import { withAiSlot } from "@kiwi/ai";
import { buildDescription } from "./description";
import { createWorkerClient } from "./ai";
import { chunkItems } from "./chunk";
import { DESCRIPTION_BATCH_SIZE } from "./description-workflow";

type SourceEmbeddingUpdate = {
    id: string;
    embedding: number[];
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

export function createDescriptionClient(graphId: string): Effect.Effect<DescriptionClient, unknown> {
    return createWorkerClient(graphId);
}

export function updateSourceEmbeddingsBatch(
    tx: { execute: typeof db.execute },
    updates: SourceEmbeddingUpdate[]
): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        if (updates.length === 0) {
            return;
        }

        yield* Effect.tryPromise(() =>
            tx.execute(sql`
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
            `).then(() => undefined)
        );
    });
}

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

function regenerateDescriptions(
    items: DescriptionItem[],
    client: DescriptionClient,
    update: (args: {
        id: string;
        description: string;
        embedding: number[];
        sourceEmbeddings: SourceEmbeddingUpdate[];
    }) => Effect.Effect<void, unknown>,
    deactivate: (id: string) => Effect.Effect<void, unknown>
): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        for (const chunk of chunkItems(items, DESCRIPTION_BATCH_SIZE)) {
            yield* Effect.all(
                chunk.map((item) =>
                    Effect.gen(function* () {
                        if (item.sources.length === 0) {
                            yield* deactivate(item.id);
                            return;
                        }

                        const sourceDescriptions = item.sources.map((source) => source.description);
                        const description = yield* buildDescription(
                            client.text,
                            item.name,
                            sourceDescriptions,
                            item.description
                        );

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

                        yield* update({
                            id: item.id,
                            description,
                            embedding,
                            sourceEmbeddings: item.sources.map((source, index) => ({
                                id: source.id,
                                embedding: sourceEmbeddings[index]!,
                            })),
                        });
                    })
                ),
                { concurrency: "unbounded" }
            );
        }
    });
}

export function regenerateEntities(
    graphId: string,
    entityIds: string[],
    client?: DescriptionClient
): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        if (entityIds.length === 0) {
            return;
        }
        const descriptionClient = client ?? (yield* createDescriptionClient(graphId));

        const entities = yield* Effect.tryPromise(() =>
            db
                .select({ id: entityTable.id, name: entityTable.name, description: entityTable.description })
                .from(entityTable)
                .where(and(eq(entityTable.graphId, graphId), inArray(entityTable.id, entityIds)))
        );

        if (entities.length === 0) {
            return;
        }

        const sources = yield* Effect.tryPromise(() =>
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
            ({ id, description, embedding, sourceEmbeddings }) =>
                Effect.tryPromise(() =>
                    db.transaction(async (tx) => {
                        await tx
                            .update(entityTable)
                            .set({
                                description,
                                embedding,
                                active: true,
                            })
                            .where(eq(entityTable.id, id));

                        await Effect.runPromise(updateSourceEmbeddingsBatch(tx, sourceEmbeddings));
                    })
                ),
            (id) =>
                Effect.tryPromise(() =>
                    db.update(entityTable).set({ active: false }).where(eq(entityTable.id, id)).then(() => undefined)
                )
        );
    });
}

export function regenerateRelationships(
    graphId: string,
    relationshipIds: string[],
    client?: DescriptionClient
): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
        if (relationshipIds.length === 0) {
            return;
        }
        const descriptionClient = client ?? (yield* createDescriptionClient(graphId));

        const relationships = yield* Effect.tryPromise(() =>
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

        const relationshipSources = yield* Effect.tryPromise(() =>
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
                ? yield* Effect.tryPromise(() =>
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
            ({ id, description, embedding, sourceEmbeddings }) =>
                Effect.tryPromise(() =>
                    db.transaction(async (tx) => {
                        await tx
                            .update(relationshipTable)
                            .set({
                                description,
                                embedding,
                                active: true,
                            })
                            .where(eq(relationshipTable.id, id));

                        await Effect.runPromise(updateSourceEmbeddingsBatch(tx, sourceEmbeddings));
                    })
                ),
            (id) =>
                Effect.tryPromise(() =>
                    db.update(relationshipTable).set({ active: false }).where(eq(relationshipTable.id, id)).then(() => undefined)
                )
        );
    });
}
