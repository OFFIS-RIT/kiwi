import { db } from "@kiwi/db";
import {
    entityTable,
    filesTable,
    relationshipTable,
    sourcesTable,
    textUnitTable,
} from "@kiwi/db/tables/graph";
import { deleteFile as deleteStoredFile } from "@kiwi/files";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { embedMany } from "ai";
import { getClient } from "@kiwi/ai";
import { defineWorkflow } from "openworkflow";
import { buildDescription } from "../lib/description";
import { buildAdapter, buildEmbeddingAdapter } from "../lib/ai";
import { env } from "../env";
import { chunkItems } from "../lib/chunk";
import { textArray } from "../lib/sql";
import { deleteFileSpec } from "./delete-file-spec";
import { deleteDerivedFileArtifacts } from "../lib/derived-files";

const WORKFLOW_STORAGE_VERSION = "v1";

function createDescriptionClient() {
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
        throw new Error("Text and embedding adapters are required for delete-file regeneration");
    }

    return {
        text: client.text,
        embedding: client.embedding,
    };
}

async function regenerateEntities(
    graphId: string,
    entityIds: string[],
    client: ReturnType<typeof createDescriptionClient>
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

    const sourcesByEntity = new Map<string, typeof sources>();
    for (const source of sources) {
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

    type EntityResult = {
        id: string;
        description: string;
        sourceIds: string[];
        sourceDescriptions: string[];
    };

    const results: EntityResult[] = [];
    for (const chunk of chunkItems(entities, 100)) {
        const chunkResults = await Promise.all(
            chunk.map(async (entity): Promise<EntityResult | null> => {
                const entitySources = sourcesByEntity.get(entity.id) || [];
                if (entitySources.length === 0) {
                    return null;
                }

                const sourceDescriptions = entitySources.map((source) => source.description);
                const description = await buildDescription(
                    client.text,
                    entity.name,
                    sourceDescriptions,
                    entity.description
                );

                return {
                    id: entity.id,
                    description,
                    sourceIds: entitySources.map((source) => source.id),
                    sourceDescriptions,
                };
            })
        );

        results.push(...chunkResults.filter((result): result is EntityResult => result !== null));
    }

    if (results.length === 0) {
        return;
    }

    const { embeddings: entityEmbeddings } = await embedMany({
        model: client.embedding,
        values: results.map((result) => result.description),
    });

    const allSourceIds = results.flatMap((result) => result.sourceIds);
    const allSourceDescriptions = results.flatMap((result) => result.sourceDescriptions);
    const { embeddings: sourceEmbeddings } = await embedMany({
        model: client.embedding,
        values: allSourceDescriptions,
    });

    await db.transaction(async (tx) => {
        for (let index = 0; index < results.length; index++) {
            const result = results[index]!;
            await tx
                .update(entityTable)
                .set({
                    description: result.description,
                    embedding: entityEmbeddings[index]!,
                    active: true,
                })
                .where(eq(entityTable.id, result.id));
        }

        for (let index = 0; index < allSourceIds.length; index++) {
            await tx
                .update(sourcesTable)
                .set({
                    embedding: sourceEmbeddings[index]!,
                    active: true,
                })
                .where(eq(sourcesTable.id, allSourceIds[index]!));
        }
    });
}

async function regenerateRelationships(
    graphId: string,
    relationshipIds: string[],
    client: ReturnType<typeof createDescriptionClient>
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

    const relationshipSourcesById = new Map<string, typeof relationshipSources>();
    for (const source of relationshipSources) {
        if (!source.relationshipId) {
            continue;
        }

        let group = relationshipSourcesById.get(source.relationshipId);
        if (!group) {
            group = [];
            relationshipSourcesById.set(source.relationshipId, group);
        }
        group.push(source);
    }

    const entityIds = [
        ...new Set(relationships.flatMap((relationship) => [relationship.sourceId, relationship.targetId])),
    ];
    const entityNames =
        entityIds.length > 0
            ? await db
                  .select({ id: entityTable.id, name: entityTable.name })
                  .from(entityTable)
                  .where(inArray(entityTable.id, entityIds))
            : [];
    const entityNameMap = new Map(entityNames.map((entity) => [entity.id, entity.name]));

    type RelationshipResult = {
        id: string;
        description: string;
        sourceIds: string[];
        sourceDescriptions: string[];
    };

    const results: RelationshipResult[] = [];
    for (const chunk of chunkItems(relationships, 100)) {
        const chunkResults = await Promise.all(
            chunk.map(async (relationship): Promise<RelationshipResult | null> => {
                const sources = relationshipSourcesById.get(relationship.id) || [];
                if (sources.length === 0) {
                    return null;
                }

                const sourceName = entityNameMap.get(relationship.sourceId) || "Unknown";
                const targetName = entityNameMap.get(relationship.targetId) || "Unknown";
                const sourceDescriptions = sources.map((source) => source.description);
                const description = await buildDescription(
                    client.text,
                    `${sourceName} -> ${targetName}`,
                    sourceDescriptions,
                    relationship.description
                );

                return {
                    id: relationship.id,
                    description,
                    sourceIds: sources.map((source) => source.id),
                    sourceDescriptions,
                };
            })
        );

        results.push(...chunkResults.filter((result): result is RelationshipResult => result !== null));
    }

    if (results.length === 0) {
        return;
    }

    const { embeddings: relationshipEmbeddings } = await embedMany({
        model: client.embedding,
        values: results.map((result) => result.description),
    });

    const allSourceIds = results.flatMap((result) => result.sourceIds);
    const allSourceDescriptions = results.flatMap((result) => result.sourceDescriptions);
    const { embeddings: sourceEmbeddings } = await embedMany({
        model: client.embedding,
        values: allSourceDescriptions,
    });

    await db.transaction(async (tx) => {
        for (let index = 0; index < results.length; index++) {
            const result = results[index]!;
            await tx
                .update(relationshipTable)
                .set({
                    description: result.description,
                    embedding: relationshipEmbeddings[index]!,
                    active: true,
                })
                .where(eq(relationshipTable.id, result.id));
        }

        for (let index = 0; index < allSourceIds.length; index++) {
            await tx
                .update(sourcesTable)
                .set({
                    embedding: sourceEmbeddings[index]!,
                    active: true,
                })
                .where(eq(sourcesTable.id, allSourceIds[index]!));
        }
    });
}

export const deleteProjectFile = defineWorkflow(deleteFileSpec, async ({ input, step }) => {
    const [fileData] = await step.run({ name: "get-file-data" }, async () => {
        return db
            .select({
                id: filesTable.id,
                graphId: filesTable.graphId,
                key: filesTable.key,
                type: filesTable.type,
                name: filesTable.name,
            })
            .from(filesTable)
            .where(and(eq(filesTable.graphId, input.graphId), eq(filesTable.id, input.fileId)))
            .limit(1);
    });

    if (!fileData) {
        return;
    }

    const cleanup = await step.run({ name: "remove-file-graph-data" }, async () => {
        return db.transaction(async (tx) => {
            const affectedEntityRows = await tx
                .selectDistinct({ id: sourcesTable.entityId })
                .from(sourcesTable)
                .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                .where(and(eq(textUnitTable.fileId, input.fileId), isNotNull(sourcesTable.entityId)));
            const affectedRelationshipRows = await tx
                .selectDistinct({ id: sourcesTable.relationshipId })
                .from(sourcesTable)
                .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                .where(and(eq(textUnitTable.fileId, input.fileId), isNotNull(sourcesTable.relationshipId)));

            const affectedEntityIds = affectedEntityRows.map((row) => row.id).filter((id): id is string => id !== null);
            const affectedRelationshipIds = affectedRelationshipRows
                .map((row) => row.id)
                .filter((id): id is string => id !== null);

            await tx.delete(textUnitTable).where(eq(textUnitTable.fileId, input.fileId));

            if (affectedEntityIds.length > 0) {
                const entityIds = textArray(affectedEntityIds);

                await tx.execute(sql`
                        DELETE FROM entities entity
                        WHERE entity.graph_id = ${input.graphId}
                          AND entity.id = ANY(${entityIds})
                          AND NOT EXISTS (
                              SELECT 1
                              FROM sources source
                              WHERE source.entity_id = entity.id
                          )
                    `);
            }

            if (affectedRelationshipIds.length > 0) {
                const relationshipIds = textArray(affectedRelationshipIds);

                await tx.execute(sql`
                        DELETE FROM relationships relationship
                        WHERE relationship.graph_id = ${input.graphId}
                          AND relationship.id = ANY(${relationshipIds})
                          AND NOT EXISTS (
                              SELECT 1
                              FROM sources source
                              WHERE source.relationship_id = relationship.id
                          )
                    `);
            }

            await tx.delete(filesTable).where(and(eq(filesTable.graphId, input.graphId), eq(filesTable.id, input.fileId)));

            const survivingEntityIds =
                affectedEntityIds.length > 0
                    ? await tx
                          .select({ id: entityTable.id })
                          .from(entityTable)
                          .where(and(eq(entityTable.graphId, input.graphId), inArray(entityTable.id, affectedEntityIds)))
                    : [];
            const survivingRelationshipIds =
                affectedRelationshipIds.length > 0
                    ? await tx
                          .select({ id: relationshipTable.id })
                          .from(relationshipTable)
                          .where(
                              and(eq(relationshipTable.graphId, input.graphId), inArray(relationshipTable.id, affectedRelationshipIds))
                          )
                    : [];

            return {
                entityIds: survivingEntityIds.map((row) => row.id),
                relationshipIds: survivingRelationshipIds.map((row) => row.id),
            };
        });
    });

    if (cleanup.entityIds.length > 0 || cleanup.relationshipIds.length > 0) {
        const client = createDescriptionClient();

        await step.run({ name: "regenerate-entity-descriptions" }, async () => {
            await regenerateEntities(input.graphId, cleanup.entityIds, client);
        });

        await step.run({ name: "regenerate-relationship-descriptions" }, async () => {
            await regenerateRelationships(input.graphId, cleanup.relationshipIds, client);
        });
    }

    await step.run({ name: "delete-s3-file" }, async () => {
        await deleteStoredFile(fileData.key, env.S3_BUCKET);
    });

    await step.run({ name: "delete-derived-file-artifacts" }, async () => {
        await deleteDerivedFileArtifacts(input.graphId, input.fileId, env.S3_BUCKET);
    });

    await step.run({ name: "delete-workflow-artifacts" }, async () => {
        const workflowPath = `graphs/${input.graphId}/workflows/${WORKFLOW_STORAGE_VERSION}/${input.fileId}`;

        await Promise.all([
            deleteStoredFile(`${workflowPath}/units.json`, env.S3_BUCKET),
            deleteStoredFile(`${workflowPath}/graph.json`, env.S3_BUCKET),
        ]);
    });
});
