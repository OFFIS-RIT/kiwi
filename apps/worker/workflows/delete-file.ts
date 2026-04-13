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
import { defineWorkflow } from "openworkflow";
import { env } from "../env";
import { chunkItems } from "../lib/chunk";
import { DESCRIPTION_BATCH_SIZE } from "../lib/description-workflow";
import { textArray } from "../lib/sql";
import { deleteFileSpec } from "./delete-file-spec";
import { deleteDerivedFileArtifacts } from "../lib/derived-files";
import { updateDescriptionsSpec } from "./update-descriptions-spec";

const WORKFLOW_STORAGE_VERSION = "v1";

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
        const descriptionWorkflowRuns = [
            ...chunkItems(cleanup.entityIds, DESCRIPTION_BATCH_SIZE).map((entityIds) =>
                step.runWorkflow(updateDescriptionsSpec, { graphId: input.graphId, entityIds })
            ),
            ...chunkItems(cleanup.relationshipIds, DESCRIPTION_BATCH_SIZE).map((relationshipIds) =>
                step.runWorkflow(updateDescriptionsSpec, { graphId: input.graphId, relationshipIds })
            ),
        ];

        await Promise.all(descriptionWorkflowRuns);
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
