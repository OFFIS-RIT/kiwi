import { db } from "@kiwi/db";
import { entityTable, relationshipTable, sourcesTable } from "@kiwi/db/tables/graph";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { embed, embedMany } from "ai";
import { getClient, withAiSlot } from "@kiwi/ai";
import { buildDescription } from "./description";
import { buildAdapter, buildEmbeddingAdapter } from "./ai";
import { env } from "../env";
import { chunkItems } from "./chunk";
import { DESCRIPTION_BATCH_SIZE } from "./description-workflow";

type SourceEmbeddingUpdate = {
    id: string;
    embedding: number[];
};

type DescriptionClient = {
    text: ReturnType<typeof getClient>["text"];
    embedding: ReturnType<typeof getClient>["embedding"];
};

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

export function createDescriptionClient(): { text: NonNullable<DescriptionClient["text"]>; embedding: NonNullable<DescriptionClient["embedding"]> } {
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

    return {
        text: client.text,
        embedding: client.embedding,
    };
}

export async function updateSourceEmbeddingsBatch(
    tx: { execute: typeof db.execute },
    updates: SourceEmbeddingUpdate[]
) {
    if (updates.length === 0) {
        return;
    }

    await tx.execute(sql`
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
    `);
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

async function regenerateDescriptions(
    items: DescriptionItem[],
    client: ReturnType<typeof createDescriptionClient>,
    update: (args: { id: string; description: string; embedding: number[]; sourceEmbeddings: SourceEmbeddingUpdate[] }) => Promise<void>
) {
    for (const chunk of chunkItems(items, DESCRIPTION_BATCH_SIZE)) {
        await Promise.all(
            chunk.map(async (item) => {
                if (item.sources.length === 0) {
                    return;
                }

                const sourceDescriptions = item.sources.map((source) => source.description);
                const description = await buildDescription(client.text, item.name, sourceDescriptions, item.description);

                const { embedding } = await withAiSlot("embedding", () =>
                    embed({
                        model: client.embedding,
                        value: description,
                    })
                );

                const { embeddings: sourceEmbeddings } = await withAiSlot("embedding", () =>
                    embedMany({
                        model: client.embedding,
                        values: sourceDescriptions,
                    })
                );

                await update({
                    id: item.id,
                    description,
                    embedding,
                    sourceEmbeddings: item.sources.map((source, index) => ({
                        id: source.id,
                        embedding: sourceEmbeddings[index]!,
                    })),
                });
            })
        );
    }
}

export async function regenerateEntities(
    graphId: string,
    entityIds: string[],
    client = createDescriptionClient()
) {
    if (entityIds.length === 0) {
        return;
    }

    const entities = await db
        .select({ id: entityTable.id, name: entityTable.name, description: entityTable.description })
        .from(entityTable)
        .where(and(eq(entityTable.graphId, graphId), inArray(entityTable.id, entityIds)));

    if (entities.length === 0) {
        return;
    }

    const sources = await db
        .select({
            id: sourcesTable.id,
            entityId: sourcesTable.entityId,
            description: sourcesTable.description,
        })
        .from(sourcesTable)
        .where(
            and(
                inArray(
                    sourcesTable.entityId,
                    entities.map((entity) => entity.id)
                ),
                isNotNull(sourcesTable.entityId)
            )
        );

    const sourcesByEntity = groupSources(sources, (source) => source.entityId);

    await regenerateDescriptions(
        entities.map((entity) => ({
            id: entity.id,
            name: entity.name,
            description: entity.description,
            sources: sourcesByEntity.get(entity.id) ?? [],
        })),
        client,
        async ({ id, description, embedding, sourceEmbeddings }) => {
            await db.transaction(async (tx) => {
                await tx
                    .update(entityTable)
                    .set({
                        description,
                        embedding,
                        active: true,
                    })
                    .where(eq(entityTable.id, id));

                await updateSourceEmbeddingsBatch(tx, sourceEmbeddings);
            });
        }
    );
}

export async function regenerateRelationships(
    graphId: string,
    relationshipIds: string[],
    client = createDescriptionClient()
) {
    if (relationshipIds.length === 0) {
        return;
    }

    const relationships = await db
        .select({
            id: relationshipTable.id,
            sourceId: relationshipTable.sourceId,
            targetId: relationshipTable.targetId,
            description: relationshipTable.description,
        })
        .from(relationshipTable)
        .where(and(eq(relationshipTable.graphId, graphId), inArray(relationshipTable.id, relationshipIds)));

    if (relationships.length === 0) {
        return;
    }

    const relationshipSources = await db
        .select({
            id: sourcesTable.id,
            relationshipId: sourcesTable.relationshipId,
            description: sourcesTable.description,
        })
        .from(sourcesTable)
        .where(
            and(
                inArray(
                    sourcesTable.relationshipId,
                    relationships.map((relationship) => relationship.id)
                ),
                isNotNull(sourcesTable.relationshipId)
            )
        );

    const relationshipSourcesById = groupSources(relationshipSources, (source) => source.relationshipId);

    const entityIds = [...new Set(relationships.flatMap((relationship) => [relationship.sourceId, relationship.targetId]))];
    const entityNames =
        entityIds.length > 0
            ? await db
                  .select({ id: entityTable.id, name: entityTable.name })
                  .from(entityTable)
                  .where(inArray(entityTable.id, entityIds))
            : [];
    const entityNameMap = new Map(entityNames.map((entity) => [entity.id, entity.name]));

    await regenerateDescriptions(
        relationships.map((relationship) => ({
            id: relationship.id,
            name: `${entityNameMap.get(relationship.sourceId) || "Unknown"} -> ${entityNameMap.get(relationship.targetId) || "Unknown"}`,
            description: relationship.description,
            sources: relationshipSourcesById.get(relationship.id) ?? [],
        })),
        client,
        async ({ id, description, embedding, sourceEmbeddings }) => {
            await db.transaction(async (tx) => {
                await tx
                    .update(relationshipTable)
                    .set({
                        description,
                        embedding,
                        active: true,
                    })
                    .where(eq(relationshipTable.id, id));

                await updateSourceEmbeddingsBatch(tx, sourceEmbeddings);
            });
        }
    );
}
