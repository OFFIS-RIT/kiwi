import { db } from "@kiwi/db";
import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import { filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import { embed, tool } from "ai";
import { withAiSlot } from "../concurrency";
import {
    decodeCursor,
    encodeCursor,
    EXACT_BOOST,
    greatest,
    KEYWORD_WEIGHT,
    MIN_KEYWORD_BOOST,
    MIN_SEMANTIC_SCORE,
    normalizeTerms,
    PREFIX_BOOST,
    truncateWords,
    type RankCursor,
} from "./lib/search";
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
                    when lower(file.name) = lower(${term}) then ${EXACT_BOOST}
                    when file.name ilike ${`${term}%`} then ${PREFIX_BOOST}
                    else 0
                end`
        )
    );
}

function buildFileScopeExpression(fileIds: string[]) {
    if (fileIds.length === 0) {
        return sql``;
    }

    return sql`
        and text_unit.file_id in (${sql.join(
            fileIds.map((fileId) => sql`${fileId}`),
            sql`, `
        )})
    `;
}

function buildSubjectScopeExpression(entityIds: string[], relationshipIds: string[]) {
    const scopes: SQL[] = [];

    if (entityIds.length > 0) {
        scopes.push(sql`source.entity_id in (${sql.join(entityIds.map((entityId) => sql`${entityId}`), sql`, `)})`);
    }

    if (relationshipIds.length > 0) {
        scopes.push(
            sql`source.relationship_id in (${sql.join(relationshipIds.map((relationshipId) => sql`${relationshipId}`), sql`, `)})`
        );
    }

    if (scopes.length === 1) {
        return sql`and ${scopes[0]!}`;
    }

    return sql`and (${sql.join(scopes, sql` or `)})`;
}

function toSearchSourceRows(rows: Record<string, unknown>[]): SearchSourceRow[] {
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
        const subject = row.entityId ? `entity ${row.entityId}` : row.relationshipId ? `relationship ${row.relationshipId}` : "unlinked";

        return `- ${row.id}, ${subject}, file ${row.fileId} ${row.fileName}, ${truncateWords(row.description) || "No description"}, excerpt: ${shortExcerpt || "No excerpt"}`;
    });
}

const getSourcesSchema = z.object({
    query: z
        .string()
        .describe(
            "Optional short phrase to refine already-scoped sources after you have selected entityIds or relationshipIds."
        )
        .optional(),
    keywords: z.array(z.string()).describe("Optional extra terms to refine already-scoped source matching.").optional(),
    files: z
        .array(z.string())
        .describe("Optional file IDs to narrow the evidence set after choosing entities or relationships.")
        .optional(),
    entityIds: z
        .array(z.string())
        .describe("Entity IDs you already identified and now want grounding evidence for.")
        .optional(),
    relationshipIds: z
        .array(z.string())
        .describe("Relationship IDs you already identified and now want grounding evidence for.")
        .optional(),
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of sources to return."),
    cursor: z.string().describe("Pagination cursor from a previous result page.").optional(),
});

export const getSourcesTool = (graphId: string, embeddingModel: EmbeddingModelV3) =>
    tool({
        description:
            "Final grounding tool. Use only after researching entities or relationships first. When you provide a refinement query, semantic search is primary and keywords boost exact file or source text matches. The returned source IDs are the citation IDs that the final answer must cite.",
        inputSchema: getSourcesSchema,
        execute: ({ query, keywords, files, entityIds: rawEntityIds, relationshipIds: rawRelationshipIds, limit, cursor }) =>
            runToolSafely(
                {
                    title: "Sources",
                    name: "get_sources",
                    hints: [
                        "call this only after you already have entityIds or relationshipIds",
                        "retry with fewer file filters or without a refinement query",
                    ],
                },
                async () => {
                    const fileIds = normalizeTerms(files ?? []);
                    const entityIds = normalizeTerms(rawEntityIds ?? []);
                    const relationshipIds = normalizeTerms(rawRelationshipIds ?? []);
                    const text = query?.trim() ?? "";
                    const terms = normalizeTerms([text, ...(keywords ?? [])]);

                    if (entityIds.length === 0 && relationshipIds.length === 0) {
                        return [
                            "## Sources",
                            "Use source IDs from this tool as citations in the final answer.",
                            "- hint: do entity and relationship research first, then call this tool with at least one entityId or relationshipId.",
                        ].join("\n");
                    }

                    if (terms.length === 0) {
                        const clauses = [eq(sourcesTable.active, true), eq(filesTable.graphId, graphId)];

                        if (cursor) {
                            clauses.push(gt(sourcesTable.id, cursor));
                        }

                        if (fileIds.length > 0) {
                            clauses.push(inArray(textUnitTable.fileId, fileIds));
                        }

                        if (entityIds.length > 0 || relationshipIds.length > 0) {
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
                        }

                        const rows = await db
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
                            .limit(limit + 1);

                        const hasMore = rows.length > limit;
                        const items = hasMore ? rows.slice(0, limit) : rows;

                        return [
                            "## Sources",
                            "Use source IDs below as citations in the final answer.",
                            ...(items.length > 0 ? formatSourceList(items) : ["- none"]),
                            ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
                        ].join("\n");
                    }

                    const next = decodeCursor(cursor, "source search");
                    const fileScope = buildFileScopeExpression(fileIds);
                    const subjectScope = buildSubjectScopeExpression(entityIds, relationshipIds);
                    const keywordBoost = buildSourceKeywordBoostExpression(terms);
                    const exactBoost = buildSourceExactBoostExpression(terms);
                    const queryVector = text
                        ? JSON.stringify(
                              (
                                  await withAiSlot("embedding", () =>
                                      embed({
                                          model: embeddingModel,
                                          value: text,
                                      })
                                  )
                              ).embedding
                          )
                        : undefined;
                    const semanticScoreExpression = queryVector
                        ? sql`greatest(0::double precision, 1 - (source.embedding <=> ${queryVector}::vector))`
                        : sql`0::double precision`;
                    const score = sql`${semanticScoreExpression} + (${keywordBoost} * ${KEYWORD_WEIGHT}) + ${exactBoost}`;
                    const cursorFilter = next
                        ? sql`
                              and (
                                  ranked.score < ${next.score}
                                  or (ranked.score = ${next.score} and ranked.id > ${next.id})
                              )
                          `
                        : sql``;
                    const result = await db.execute(sql<SearchSourceRow>`
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
                            where source.active = true
                              and file.graph_id = ${graphId}
                              ${fileScope}
                              ${subjectScope}
                        )
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
                            ranked.semantic_score >= ${MIN_SEMANTIC_SCORE}
                            or ranked.keyword_boost >= ${MIN_KEYWORD_BOOST}
                            or ranked.exact_boost > 0
                        )
                        ${cursorFilter}
                        order by ranked.score desc, ranked.id asc
                        limit ${limit + 1}
                    `);
                    const rows = toSearchSourceRows(result.rows);
                    const hasMore = rows.length > limit;
                    const items = hasMore ? rows.slice(0, limit) : rows;

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
                }
            ),
    });

const tools = {
    getSourcesTool,
};

export default tools;
