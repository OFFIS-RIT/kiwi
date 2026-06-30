import { Database, DatabaseError, runDatabaseEffect } from "@kiwi/db/effect";
import type { EmbeddingModel } from "ai";
import { filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import {
    currentSourcePredicate,
    currentSourceSql,
    visibleFilePredicate,
    visibleFileSql,
} from "@kiwi/db/source-validity";
import { and, asc, cosineDistance, eq, gt, inArray, or, sql, type SQL } from "@kiwi/db/drizzle";
import * as Effect from "effect/Effect";
import { embed, tool } from "ai";
import { withAiSlotEffect, type AiProviderError } from "../concurrency";
import {
    decodeCursor,
    doubleLiteral,
    encodeCursor,
    EXACT_BOOST,
    greatest,
    KEYWORD_WEIGHT,
    MIN_KEYWORD_BOOST,
    MIN_SEMANTIC_SCORE,
    uniqueTerms,
    PREFIX_BOOST,
    truncateWords,
    type RankCursor,
} from "./lib/search";
import { fileContentScopePredicate, fileContentScopeSql, type GraphContentScope } from "./content-scope";
import { runToolSafely } from "./lib/execute";
import { z } from "zod";

type SearchSourceRow = {
    id: string;
    entityId: string;
    relationshipId: string;
    description: string;
    text: string;
    fileId: string;
    fileName: string;
    score: number;
};
type SeedSourceRow = {
    id: string;
    entityId: string | null;
    relationshipId: string | null;
    description: string;
    fileId: string;
    fileName: string;
};

type SimilarSourceRow = {
    id: string;
    entityId: string;
    relationshipId: string;
    description: string;
    text: string;
    fileId: string;
    fileName: string;
    distance: number;
};

function buildSourceKeywordBoostExpression(terms: string[]) {
    return greatest(
        terms.flatMap((term) => [sql`similarity(source.description, ${term})`, sql`similarity(file.name, ${term})`])
    );
}

function buildSourceExactBoostExpression(terms: string[]) {
    return greatest(
        terms.map(
            (term) =>
                sql`case
                    when lower(file.name) = lower(${term}) then ${doubleLiteral(EXACT_BOOST)}
                    when file.name ilike ${`${term}%`} then ${doubleLiteral(PREFIX_BOOST)}
                    else 0::double precision
                end`
        )
    );
}

function buildFileScopeExpression(fileIds: string[], contentScope: GraphContentScope | undefined) {
    const scopeFilter = fileContentScopeSql(contentScope, "file");
    if (fileIds.length === 0 && !scopeFilter) {
        return sql``;
    }

    return sql`
        ${
            fileIds.length > 0
                ? sql`and text_unit.file_id in (${sql.join(
                      fileIds.map((fileId) => sql`${fileId}`),
                      sql`, `
                  )})`
                : sql``
        }
        ${scopeFilter ? sql`and ${scopeFilter}` : sql``}
    `;
}
function buildExcludedSourceExpression(sourceIds: string[]) {
    if (sourceIds.length === 0) {
        return sql``;
    }

    return sql`
        and candidate.id not in (${sql.join(
            sourceIds.map((sourceId) => sql`${sourceId}`),
            sql`, `
        )})
    `;
}

function buildSubjectScopeExpression(entityIds: string[], relationshipIds: string[]) {
    const scopes: SQL[] = [];

    if (entityIds.length > 0) {
        scopes.push(
            sql`source.entity_id in (${sql.join(
                entityIds.map((entityId) => sql`${entityId}`),
                sql`, `
            )})`
        );
    }

    if (relationshipIds.length > 0) {
        scopes.push(
            sql`source.relationship_id in (${sql.join(
                relationshipIds.map((relationshipId) => sql`${relationshipId}`),
                sql`, `
            )})`
        );
    }

    if (scopes.length === 1) {
        return sql`and ${scopes[0]!}`;
    }

    return sql`and (${sql.join(scopes, sql` or `)})`;
}

function toSearchSourceRows(rows: readonly Record<string, unknown>[]): SearchSourceRow[] {
    return rows.map((row) => ({
        id: String(row.id ?? ""),
        entityId: String(row.entityId ?? ""),
        relationshipId: String(row.relationshipId ?? ""),
        description: String(row.description ?? ""),
        text: String(row.text ?? ""),
        fileId: String(row.fileId ?? ""),
        fileName: String(row.fileName ?? ""),
        score: Number(row.score ?? 0),
    }));
}
function toSimilarSourceRows(rows: readonly Record<string, unknown>[]): SimilarSourceRow[] {
    return rows.map((row) => ({
        id: String(row.id ?? ""),
        entityId: String(row.entityId ?? ""),
        relationshipId: String(row.relationshipId ?? ""),
        description: String(row.description ?? ""),
        text: String(row.text ?? ""),
        fileId: String(row.fileId ?? ""),
        fileName: String(row.fileName ?? ""),
        distance: Number(row.distance ?? 0),
    }));
}

function formatSubject(entityId: string | null | undefined, relationshipId: string | null | undefined) {
    return entityId ? `entity ${entityId}` : relationshipId ? `relationship ${relationshipId}` : "unlinked";
}

function formatDistance(distance: number) {
    return Number.isFinite(distance) ? distance.toFixed(3) : "unknown";
}

function formatSimilarity(distance: number) {
    return Number.isFinite(distance) ? (1 - distance).toFixed(3) : "unknown";
}

function formatSourceList(
    rows: Array<{
        id: string;
        entityId: string | null;
        relationshipId: string | null;
        description: string;
        text: string;
        fileId: string;
        fileName: string;
    }>
) {
    return rows.map((row) => {
        const shortExcerpt = truncateWords(row.text);
        const subject = formatSubject(row.entityId, row.relationshipId);

        return `- ${row.id}, ${subject}, file ${row.fileId} ${row.fileName}, ${truncateWords(row.description) || "No description"}, excerpt: ${shortExcerpt || "No excerpt"}`;
    });
}

const sourceLookupSchema = z.object({
    query: z
        .string()
        .describe(
            "Optional short phrase to refine already-scoped sources after you have selected entities or relationships."
        )
        .optional(),
    keywords: z.array(z.string()).describe("Optional extra terms to refine already-scoped source matching.").optional(),
    files: z
        .array(z.string())
        .describe("Optional file IDs to narrow the evidence set after choosing entities or relationships.")
        .optional(),
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of sources to return."),
    cursor: z.string().describe("Pagination cursor from a previous result page.").optional(),
});

const getEntitySourcesSchema = sourceLookupSchema.extend({
    entityIds: z
        .array(z.string())
        .min(1)
        .describe("Entity IDs you already identified and now want grounding evidence for."),
});

const getRelationshipSourcesSchema = sourceLookupSchema.extend({
    relationshipIds: z
        .array(z.string())
        .min(1)
        .describe("Relationship IDs you already identified and now want grounding evidence for."),
});

const getSourceFileMetadataSchema = z.object({
    sourceIds: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe("Source IDs whose underlying file metadata should be inspected."),
});
const similarSourcesCheckSchema = z.object({
    sourceIds: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe(
            "All source IDs already found for a candidate direct factual answer; these are excluded while finding new semantically similar sources."
        ),
    excludeSourceIds: z
        .array(z.string())
        .max(100)
        .describe(
            "Optional additional source IDs already seen in this conversation; these are also excluded from results."
        )
        .optional(),
    files: z.array(z.string()).describe("Optional file IDs to narrow similar-source candidates.").optional(),
    limit: z
        .number()
        .min(1)
        .max(30)
        .default(10)
        .describe("Maximum number of new similar sources to return per seed source."),
});

type SourceToolOptions = {
    contentScope?: GraphContentScope;
    onConsideredFileIds?: (fileIds: Iterable<string>) => void;
};

type GetScopedSourcesArgs = {
    query?: string;
    keywords?: string[];
    files?: string[];
    entityIds?: string[];
    relationshipIds?: string[];
    limit: number;
    cursor?: string;
    onConsideredFileIds?: SourceToolOptions["onConsideredFileIds"];
    contentScope?: GraphContentScope;
};

function getScopedSources(
    graphId: string,
    embeddingModel: EmbeddingModel,
    {
        query,
        keywords,
        files,
        entityIds: entities,
        relationshipIds: relationships,
        limit,
        cursor,
        onConsideredFileIds,
        contentScope,
    }: GetScopedSourcesArgs
): Effect.Effect<string, DatabaseError | AiProviderError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const fileIds = uniqueTerms(files ?? []);
        const entityIds = uniqueTerms(entities ?? []);
        const relationshipIds = uniqueTerms(relationships ?? []);
        const text = query?.trim() ?? "";
        const terms = uniqueTerms([text, ...(keywords ?? [])]);
        onConsideredFileIds?.(fileIds);

        if (terms.length === 0) {
            const clauses = [
                currentSourcePredicate(sourcesTable),
                eq(filesTable.graphId, graphId),
                visibleFilePredicate(filesTable),
            ];
            const scopePredicate = fileContentScopePredicate(contentScope, filesTable);
            if (scopePredicate) {
                clauses.push(scopePredicate);
            }
            if (cursor) {
                clauses.push(gt(sourcesTable.id, cursor));
            }

            if (fileIds.length > 0) {
                clauses.push(inArray(textUnitTable.fileId, fileIds));
            }

            const idClauses = [];

            if (entityIds.length > 0) {
                idClauses.push(inArray(sourcesTable.entityId, entityIds));
            }

            if (relationshipIds.length > 0) {
                idClauses.push(inArray(sourcesTable.relationshipId, relationshipIds));
            }

            if (idClauses.length === 1) {
                clauses.push(idClauses[0]!);
            } else {
                const combinedIdClause = or(...idClauses);

                if (combinedIdClause) {
                    clauses.push(combinedIdClause);
                }
            }

            const rows = yield* db
                .select({
                    id: sourcesTable.id,
                    entityId: sourcesTable.entityId,
                    relationshipId: sourcesTable.relationshipId,
                    description: sourcesTable.description,
                    text: textUnitTable.text,
                    fileId: filesTable.id,
                    fileName: filesTable.name,
                })
                .from(sourcesTable)
                .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
                .where(and(...clauses))
                .orderBy(asc(sourcesTable.id))
                .limit(limit + 1)
                .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));

            const hasMore = rows.length > limit;
            const items = hasMore ? rows.slice(0, limit) : rows;
            onConsideredFileIds?.(items.map((row) => row.fileId));

            return [
                "## Sources",
                "Use source IDs below as citations in the final answer.",
                ...(items.length > 0 ? formatSourceList(items) : ["- none"]),
                ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
            ].join("\n");
        }

        const next = decodeCursor(cursor, "source search");
        const fileScope = buildFileScopeExpression(fileIds, contentScope);
        const subjectScope = buildSubjectScopeExpression(entityIds, relationshipIds);
        const keywordBoost = buildSourceKeywordBoostExpression(terms);
        const exactBoost = buildSourceExactBoostExpression(terms);
        const queryEmbedding = text
            ? (yield* withAiSlotEffect("embedding", (signal) =>
                  embed({
                      model: embeddingModel,
                      value: text,
                      abortSignal: signal,
                  })
              )).embedding
            : undefined;
        const semanticScoreExpression = queryEmbedding
            ? sql<number>`greatest(0::double precision, 1 - (${cosineDistance(sql`source.embedding`, queryEmbedding)}))`
            : sql`0::double precision`;
        const score = sql`${semanticScoreExpression} + (${keywordBoost} * ${doubleLiteral(KEYWORD_WEIGHT)}) + ${exactBoost}`;
        const cursorFilter = next
            ? sql`
                  and (
                      ranked.score < ${next.score}
                      or (ranked.score = ${next.score} and ranked.id > ${next.id})
                  )
              `
            : sql``;
        const result = yield* db
            .execute(sql<SearchSourceRow>`
                with ranked as (
                    select
                        source.id,
                        coalesce(source.entity_id, '') as "entityId",
                        coalesce(source.relationship_id, '') as "relationshipId",
                        source.description,
                        text_unit.text,
                        file.id as "fileId",
                        file.name as "fileName",
                        ${semanticScoreExpression} as semantic_score,
                        ${keywordBoost} as keyword_boost,
                        ${exactBoost} as exact_boost,
                        ${score} as score
                    from sources source
                    inner join text_units text_unit on text_unit.id = source.text_unit_id
                    inner join files file on file.id = text_unit.file_id
                    where ${currentSourceSql("source")}
                      and ${visibleFileSql("file")}
                      and file.graph_id = ${graphId}
                      ${fileScope}
                      ${subjectScope}
                ), limited_ranked as materialized (
                    select
                        ranked.id,
                        ranked."entityId",
                        ranked."relationshipId",
                        ranked.description,
                        ranked.text,
                        ranked."fileId",
                        ranked."fileName",
                        ranked.score
                    from ranked
                    where (
                        ranked.semantic_score >= ${doubleLiteral(MIN_SEMANTIC_SCORE)}
                        or ranked.keyword_boost >= ${doubleLiteral(MIN_KEYWORD_BOOST)}
                        or ranked.exact_boost > 0
                    )
                    ${cursorFilter}
                    order by ranked.score desc, ranked.id asc
                    limit ${limit + 1}
                )
                select
                    limited_ranked.id,
                    limited_ranked."entityId",
                    limited_ranked."relationshipId",
                    limited_ranked.description,
                    limited_ranked.text,
                    limited_ranked."fileId",
                    limited_ranked."fileName",
                    limited_ranked.score
                from limited_ranked
                order by limited_ranked.score desc, limited_ranked.id asc
            `)
            .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));
        const rows = toSearchSourceRows(result);
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        onConsideredFileIds?.(items.map((row) => row.fileId));

        return [
            "## Sources",
            "Use source IDs below as citations in the final answer.",
            ...(items.length > 0 ? formatSourceList(items) : ["- none"]),
            ...(hasMore && items.length > 0
                ? [
                      ``,
                      `Next cursor: ${encodeCursor({
                          id: items[items.length - 1]!.id,
                          score: items[items.length - 1]!.score,
                      } satisfies RankCursor)}`,
                  ]
                : []),
        ].join("\n");
    });
}
function loadSeedSourceRows(
    graphId: string,
    sourceIds: string[],
    contentScope: GraphContentScope | undefined
): Effect.Effect<SeedSourceRow[], DatabaseError, Database> {
    return Effect.gen(function* () {
        const scopePredicate = fileContentScopePredicate(contentScope, filesTable);
        if (sourceIds.length === 0) {
            return [];
        }

        const db = yield* Database;
        return yield* db
            .select({
                id: sourcesTable.id,
                entityId: sourcesTable.entityId,
                relationshipId: sourcesTable.relationshipId,
                description: sourcesTable.description,
                fileId: filesTable.id,
                fileName: filesTable.name,
            })
            .from(sourcesTable)
            .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
            .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
            .where(
                and(
                    currentSourcePredicate(sourcesTable),
                    eq(filesTable.graphId, graphId),
                    visibleFilePredicate(filesTable),
                    inArray(sourcesTable.id, sourceIds),
                    ...(scopePredicate ? [scopePredicate] : [])
                )
            )
            .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));
    });
}

function getSimilarSources(
    graphId: string,
    {
        sourceIds: sources,
        excludeSourceIds,
        files,
        limit,
        onConsideredFileIds,
        contentScope,
    }: {
        sourceIds: string[];
        excludeSourceIds?: string[];
        files?: string[];
        limit: number;
        onConsideredFileIds?: SourceToolOptions["onConsideredFileIds"];
        contentScope?: GraphContentScope;
    }
): Effect.Effect<string, DatabaseError, Database> {
    return Effect.gen(function* () {
        const db = yield* Database;
        const sourceIds = uniqueTerms(sources);
        const fileIds = uniqueTerms(files ?? []);
        const excludedSourceIds = uniqueTerms([...sourceIds, ...(excludeSourceIds ?? [])]);
        const excludedSourceScope = buildExcludedSourceExpression(excludedSourceIds);
        const candidateScope = buildFileScopeExpression(fileIds, contentScope);
        const seedRows = yield* loadSeedSourceRows(graphId, sourceIds, contentScope);
        const seedById = new Map(seedRows.map((row) => [row.id, row]));
        const seenSourceIds = new Set(excludedSourceIds);
        const output: string[] = [
            "## Similar Sources Check",
            "Compare these new sources against the seed sources before answering. If any relevant result gives a different answer, version, value, outcome, or qualification, report the disagreement with citations instead of settling for one answer.",
        ];

        onConsideredFileIds?.(fileIds);
        onConsideredFileIds?.(seedRows.map((row) => row.fileId));

        for (const sourceId of sourceIds) {
            const seed = seedById.get(sourceId);

            if (!seed) {
                output.push("", `### Seed source ${sourceId}`, "- missing, inactive, deleted, or outside this graph");
                continue;
            }

            const candidateLimit = limit * 3;
            const distance = sql<number>`(candidate.embedding <=> seed.embedding)`;
            const result = yield* db
                .execute(sql<SimilarSourceRow>`
                    with seed as (
                        select source.id, source.embedding
                        from sources source
                        inner join text_units seed_text_unit on seed_text_unit.id = source.text_unit_id
                        inner join files seed_file on seed_file.id = seed_text_unit.file_id
                        where ${currentSourceSql("source")}
                          and source.id = ${seed.id}
                          and seed_file.graph_id = ${graphId}
                          and ${visibleFileSql("seed_file")}
                        limit 1
                    )
                    select
                        candidate.id,
                        coalesce(candidate.entity_id, '') as "entityId",
                        coalesce(candidate.relationship_id, '') as "relationshipId",
                        candidate.description,
                        text_unit.text,
                        file.id as "fileId",
                        file.name as "fileName",
                        ${distance} as distance
                    from seed
                    inner join sources candidate on ${currentSourceSql("candidate")}
                    inner join text_units text_unit on text_unit.id = candidate.text_unit_id
                    inner join files file on file.id = text_unit.file_id
                    where file.graph_id = ${graphId}
                      and ${visibleFileSql("file")}
                      ${candidateScope}
                      ${excludedSourceScope}
                    order by distance asc, candidate.id asc
                    limit ${candidateLimit}
                `)
                .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));
            const candidates = toSimilarSourceRows(result);
            const newCandidates = candidates.filter((candidate) => {
                if (seenSourceIds.has(candidate.id)) {
                    return false;
                }

                seenSourceIds.add(candidate.id);
                return true;
            });
            const items = newCandidates.slice(0, limit);
            const seedSubject = formatSubject(seed.entityId, seed.relationshipId);

            onConsideredFileIds?.(items.map((row) => row.fileId));
            output.push(
                "",
                `### Seed source ${seed.id}`,
                `Seed: ${seedSubject}, file ${seed.fileId} ${seed.fileName}, ${truncateWords(seed.description) || "No description"}`,
                ...(items.length > 0
                    ? items.map((row) => {
                          const subject = formatSubject(row.entityId, row.relationshipId);
                          const sameSubject =
                              (row.entityId && row.entityId === seed.entityId) ||
                              (row.relationshipId && row.relationshipId === seed.relationshipId)
                                  ? "same subject"
                                  : "different subject";

                          return `- ${row.id}, ${subject}, ${sameSubject}, file ${row.fileId} ${row.fileName}, distance ${formatDistance(row.distance)}, similarity ${formatSimilarity(row.distance)}, ${truncateWords(row.description) || "No description"}, excerpt: ${truncateWords(row.text) || "No excerpt"}`;
                      })
                    : ["- no new similar sources found"])
            );
        }

        return output.join("\n");
    });
}

export const getEntitySourcesTool = (
    graphId: string,
    embeddingModel: EmbeddingModel,
    options: SourceToolOptions = {}
) =>
    tool({
        description:
            "Final grounding tool for entities. Use only after identifying entity IDs. When you provide a refinement query, semantic search is primary and keywords boost exact file or source text matches. The returned source IDs are the citation IDs that the final answer must cite.",
        inputSchema: getEntitySourcesSchema,
        execute: ({ query, keywords, files, entityIds, limit, cursor }) =>
            runDatabaseEffect(
                runToolSafely(
                    {
                        title: "Sources",
                        name: "get_entity_sources",
                        hints: [
                            "call this only after you already have entityIds",
                            "retry with fewer file filters or without a refinement query",
                        ],
                    },
                    { query, keywords, files, entityIds, limit, cursor },
                    () =>
                        getScopedSources(graphId, embeddingModel, {
                            query,
                            keywords,
                            files,
                            entityIds,
                            limit,
                            cursor,
                            onConsideredFileIds: options.onConsideredFileIds,
                            contentScope: options.contentScope,
                        })
                )
            ),
    });

export const getRelationshipSourcesTool = (
    graphId: string,
    embeddingModel: EmbeddingModel,
    options: SourceToolOptions = {}
) =>
    tool({
        description:
            "Final grounding tool for relationships. Use only after identifying relationship IDs. When you provide a refinement query, semantic search is primary and keywords boost exact file or source text matches. The returned source IDs are the citation IDs that the final answer must cite.",
        inputSchema: getRelationshipSourcesSchema,
        execute: ({ query, keywords, files, relationshipIds, limit, cursor }) =>
            runDatabaseEffect(
                runToolSafely(
                    {
                        title: "Sources",
                        name: "get_relationship_sources",
                        hints: [
                            "call this only after you already have relationshipIds",
                            "retry with fewer file filters or without a refinement query",
                        ],
                    },
                    { query, keywords, files, relationshipIds, limit, cursor },
                    () =>
                        getScopedSources(graphId, embeddingModel, {
                            query,
                            keywords,
                            files,
                            relationshipIds,
                            limit,
                            cursor,
                            onConsideredFileIds: options.onConsideredFileIds,
                            contentScope: options.contentScope,
                        })
                )
            ),
    });

export const similarSourcesCheckTool = (graphId: string, options: SourceToolOptions = {}) =>
    tool({
        description:
            "Required verification tool for direct factual answers after get_entity_sources or get_relationship_sources returns candidate citation IDs. Finds new semantically similar source descriptions that may support, qualify, or contradict answer-determining evidence.",
        inputSchema: similarSourcesCheckSchema,
        execute: ({ sourceIds, excludeSourceIds, files, limit }) =>
            runDatabaseEffect(
                runToolSafely(
                    {
                        title: "Similar sources",
                        name: "similar_sources_check",
                        hints: [
                            "for direct factual answers, call this after source retrieval and before the final answer",
                            "pass all source IDs already found so they are excluded from results",
                            "if any returned relevant source differs from the candidate answer, report the disagreement instead of settling for one answer",
                        ],
                    },
                    { sourceIds, excludeSourceIds, files, limit },
                    () =>
                        getSimilarSources(graphId, {
                            sourceIds,
                            excludeSourceIds,
                            files,
                            limit,
                            onConsideredFileIds: options.onConsideredFileIds,
                            contentScope: options.contentScope,
                        })
                )
            ),
    });

export const getSourceFileMetadataTool = (graphId: string, options: SourceToolOptions = {}) =>
    tool({
        description:
            "Inspect the file metadata behind source IDs. Use this to judge source relevance, authority, document type, dates, binding status, or other document-level context.",
        inputSchema: getSourceFileMetadataSchema,
        execute: ({ sourceIds }) =>
            runDatabaseEffect(
                runToolSafely(
                    {
                        title: "Source file metadata",
                        name: "get_source_file_metadata",
                        hints: [
                            "call this after selecting candidate source IDs",
                            "retry with fewer source IDs if the result is too broad",
                        ],
                    },
                    { sourceIds },
                    () =>
                        Effect.gen(function* () {
                            const db = yield* Database;
                            const ids = uniqueTerms(sourceIds);
                            const scopePredicate = fileContentScopePredicate(options.contentScope, filesTable);
                            if (ids.length === 0) {
                                return "## Source File Metadata\n- none";
                            }

                            const rows = yield* db
                                .select({
                                    sourceId: sourcesTable.id,
                                    entityId: sourcesTable.entityId,
                                    relationshipId: sourcesTable.relationshipId,
                                    sourceDescription: sourcesTable.description,
                                    unitId: textUnitTable.id,
                                    fileId: filesTable.id,
                                    fileName: filesTable.name,
                                    fileType: filesTable.type,
                                    mimeType: filesTable.mimeType,
                                    size: filesTable.size,
                                    tokenCount: filesTable.tokenCount,
                                    metadata: filesTable.metadata,
                                })
                                .from(sourcesTable)
                                .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                                .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
                                .where(
                                    and(
                                        currentSourcePredicate(sourcesTable),
                                        eq(filesTable.graphId, graphId),
                                        visibleFilePredicate(filesTable),
                                        inArray(sourcesTable.id, ids),
                                        ...(scopePredicate ? [scopePredicate] : [])
                                    )
                                )
                                .pipe(Effect.mapError((cause) => new DatabaseError({ cause })));
                            options.onConsideredFileIds?.(rows.map((row) => row.fileId));

                            return [
                                "## Source File Metadata",
                                ...(rows.length > 0
                                    ? rows.map((row) => {
                                          const subject = row.entityId
                                              ? `entity ${row.entityId}`
                                              : row.relationshipId
                                                ? `relationship ${row.relationshipId}`
                                                : "unlinked";
                                          const metadata = row.metadata?.trim() || "No file metadata";

                                          return `- source ${row.sourceId}, ${subject}, unit ${row.unitId}, file ${row.fileId} ${row.fileName}, ${row.fileType}, ${row.mimeType}, ${row.size} bytes, ${row.tokenCount} tokens, source: ${truncateWords(row.sourceDescription)}, metadata: ${truncateWords(metadata, 80)}`;
                                      })
                                    : ["- none"]),
                            ].join("\n");
                        })
                )
            ),
    });

const tools = {
    getEntitySourcesTool,
    getRelationshipSourcesTool,
    similarSourcesCheckTool,
    getSourceFileMetadataTool,
};

export default tools;
