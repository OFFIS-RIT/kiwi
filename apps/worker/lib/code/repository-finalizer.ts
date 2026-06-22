import * as Effect from "effect/Effect";
import type { Database, DatabaseTransaction } from "@kiwi/db/effect";
import { withWorkerDb } from "../runtime/effect";
import { currentSourcePredicate, currentSourceSql } from "@kiwi/db/source-validity";
import { filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { and, eq, inArray, isNotNull, sql } from "@kiwi/db/drizzle";
import { codeRepositoryFileFieldsFromMetadata, parseCodeFileMetadata } from "./metadata";
import { textArray } from "../db/sql";

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
            latestRows.flatMap((row) => {
                const metadata = parseCodeFileMetadata(row.metadata);
                return metadata
                    ? [codeRepositoryFileFieldsFromMetadata(metadata, { graphId: "", name: "" }).repositoryUrl]
                    : [];
            })
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
            return (
                metadata !== null &&
                repositoryUrlSet.has(
                    codeRepositoryFileFieldsFromMetadata(metadata, { graphId: "", name: "" }).repositoryUrl
                )
            );
        })
        .map((row) => row.id);

    return { repositoryUrls, olderFileIds };
}

export function invalidateSupersededRepositorySources(options: {
    graphId: string;
    latestFileIds?: string[];
    retiredFileIds?: string[];
}): Effect.Effect<RepositorySourceInvalidationResult, unknown, Database> {
    return Effect.gen(function* () {
        if (options.retiredFileIds !== undefined) {
            return yield* invalidateRepositorySourceTargets({
                graphId: options.graphId,
                retiredFileIds: options.retiredFileIds,
                markDeleted: true,
            });
        }

        const latestFileIds = options.latestFileIds;
        if (!latestFileIds || latestFileIds.length === 0) {
            return { entityIds: [], relationshipIds: [] };
        }

        return yield* withWorkerDb((db) =>
            db.transaction((tx) =>
                Effect.gen(function* () {
                    const latestRows = yield* tx
                        .select({ id: filesTable.id, metadata: filesTable.metadata })
                        .from(filesTable)
                        .where(and(eq(filesTable.graphId, options.graphId), inArray(filesTable.id, latestFileIds)));
                    const candidateRows = yield* tx
                        .select({ id: filesTable.id, metadata: filesTable.metadata })
                        .from(filesTable)
                        .where(and(eq(filesTable.graphId, options.graphId), eq(filesTable.type, "code")));
                    const targets = resolveRepositoryFinalizationTargets(latestRows, candidateRows);
                    return yield* invalidateRepositorySources(tx, options.graphId, targets.olderFileIds, false);
                })
            )
        );
    });
}

function invalidateRepositorySourceTargets(options: {
    graphId: string;
    retiredFileIds: string[];
    markDeleted: boolean;
}): Effect.Effect<RepositorySourceInvalidationResult, unknown, Database> {
    return Effect.gen(function* () {
        if (options.retiredFileIds.length === 0) {
            return { entityIds: [], relationshipIds: [] };
        }

        return yield* withWorkerDb((db) =>
            db.transaction((tx) =>
                invalidateRepositorySources(tx, options.graphId, options.retiredFileIds, options.markDeleted)
            )
        );
    });
}

function invalidateRepositorySources(
    tx: DatabaseTransaction,
    graphId: string,
    retiredFileIds: string[],
    markDeleted: boolean
): Effect.Effect<RepositorySourceInvalidationResult, unknown> {
    return Effect.gen(function* () {
        if (retiredFileIds.length === 0) {
            return { entityIds: [], relationshipIds: [] };
        }

        if (markDeleted) {
            yield* tx
                .update(filesTable)
                .set({ deleted: true })
                .where(
                    and(
                        eq(filesTable.graphId, graphId),
                        eq(filesTable.deleted, false),
                        inArray(filesTable.id, retiredFileIds)
                    )
                );
        }

        const affectedEntityRows = yield* tx
            .selectDistinct({ id: sourcesTable.entityId })
            .from(sourcesTable)
            .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
            .where(
                and(
                    inArray(textUnitTable.fileId, retiredFileIds),
                    currentSourcePredicate(),
                    isNotNull(sourcesTable.entityId)
                )
            );
        const affectedRelationshipRows = yield* tx
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

        yield* tx.execute(sql`
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
    });
}
