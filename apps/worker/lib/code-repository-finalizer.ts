import { db } from "@kiwi/db";
import { currentSourcePredicate, currentSourceSql } from "@kiwi/db/source-validity";
import { filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { parseCodeFileMetadata } from "./code-file-metadata";
import { textArray } from "./sql";

export type RepositoryFileMetadataRow = {
    id: string;
    metadata: string | null;
};

export type RepositoryFinalizationTargets = {
    repositoryUrls: string[];
    olderFileIds: string[];
};

export type RepositorySourceInvalidationResult = {
    entityIds: string[];
    relationshipIds: string[];
};

export function resolveRepositoryFinalizationTargets(
    latestRows: RepositoryFileMetadataRow[],
    candidateRows: RepositoryFileMetadataRow[]
): RepositoryFinalizationTargets {
    const latestFileIds = new Set(latestRows.map((row) => row.id));
    const repositoryUrls = [
        ...new Set(
            latestRows
                .map((row) => parseCodeFileMetadata(row.metadata)?.repositoryUrl)
                .filter((url): url is string => url !== undefined)
        ),
    ];
    if (repositoryUrls.length === 0) {
        return { repositoryUrls: [], olderFileIds: [] };
    }

    const repositoryUrlSet = new Set(repositoryUrls);
    const olderFileIds = candidateRows
        .filter((row) => !latestFileIds.has(row.id))
        .filter((row) => {
            const metadata = parseCodeFileMetadata(row.metadata);
            return metadata !== null && repositoryUrlSet.has(metadata.repositoryUrl);
        })
        .map((row) => row.id);

    return { repositoryUrls, olderFileIds };
}

export async function invalidateSupersededRepositorySources(options: {
    graphId: string;
    latestFileIds?: string[];
    retiredFileIds?: string[];
}): Promise<RepositorySourceInvalidationResult> {
    if (options.retiredFileIds !== undefined) {
        return invalidateRepositorySourceTargets({
            graphId: options.graphId,
            retiredFileIds: options.retiredFileIds,
            markDeleted: true,
        });
    }

    if (!options.latestFileIds || options.latestFileIds.length === 0) {
        return { entityIds: [], relationshipIds: [] };
    }

    return db.transaction(async (tx) => {
        const latestRows = await tx
            .select({ id: filesTable.id, metadata: filesTable.metadata })
            .from(filesTable)
            .where(and(eq(filesTable.graphId, options.graphId), inArray(filesTable.id, options.latestFileIds)));
        const candidateRows = await tx
            .select({ id: filesTable.id, metadata: filesTable.metadata })
            .from(filesTable)
            .where(and(eq(filesTable.graphId, options.graphId), eq(filesTable.type, "code")));
        const targets = resolveRepositoryFinalizationTargets(latestRows, candidateRows);
        return invalidateRepositorySources(tx, options.graphId, targets.olderFileIds, false);
    });
}

async function invalidateRepositorySourceTargets(options: {
    graphId: string;
    retiredFileIds: string[];
    markDeleted: boolean;
}): Promise<RepositorySourceInvalidationResult> {
    if (options.retiredFileIds.length === 0) {
        return { entityIds: [], relationshipIds: [] };
    }

    return db.transaction(async (tx) =>
        invalidateRepositorySources(tx, options.graphId, options.retiredFileIds, options.markDeleted)
    );
}

async function invalidateRepositorySources(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    graphId: string,
    retiredFileIds: string[],
    markDeleted: boolean
): Promise<RepositorySourceInvalidationResult> {
    if (retiredFileIds.length === 0) {
        return { entityIds: [], relationshipIds: [] };
    }

    if (markDeleted) {
        await tx
            .update(filesTable)
            .set({ deleted: true })
            .where(and(eq(filesTable.graphId, graphId), eq(filesTable.deleted, false), inArray(filesTable.id, retiredFileIds)));
    }

    const affectedEntityRows = await tx
        .selectDistinct({ id: sourcesTable.entityId })
        .from(sourcesTable)
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .where(and(inArray(textUnitTable.fileId, retiredFileIds), currentSourcePredicate(), isNotNull(sourcesTable.entityId)));
    const affectedRelationshipRows = await tx
        .selectDistinct({ id: sourcesTable.relationshipId })
        .from(sourcesTable)
        .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
        .where(
            and(
                inArray(textUnitTable.fileId, retiredFileIds),
                currentSourcePredicate(),
                isNotNull(sourcesTable.relationshipId)
            )
        );

    await tx.execute(sql`
        UPDATE sources source
        SET valid_until = NOW()
        FROM text_units text_unit
        WHERE source.text_unit_id = text_unit.id
          AND text_unit.file_id = ANY(${textArray(retiredFileIds)})
          AND ${currentSourceSql("source")}
    `);
    return {
        entityIds: affectedEntityRows.map((row) => row.id).filter((id): id is string => id !== null),
        relationshipIds: affectedRelationshipRows.map((row) => row.id).filter((id): id is string => id !== null),
    };
}
