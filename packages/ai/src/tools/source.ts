import { db } from "@kiwi/db";
import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import { filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { and, asc, cosineDistance, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import { embed, tool } from "ai";
import { withAiSlot } from "../concurrency";
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
                    when lower(file.name) = lower(${term}) then ${doubleLiteral(EXACT_BOOST)}
                    when file.name ilike ${`${term}%`} then ${doubleLiteral(PREFIX_BOOST)}
                    else 0::double precision
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
        const subject = row.entityId
            ? `entity ${row.entityId}`
            : row.relationshipId
              ? `relationship ${row.relationshipId}`
              : "unlinked";

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

type GetScopedSourcesArgs = {
    query?: string;
    keywords?: string[];
    files?: string[];
    entityIds?: string[];
    relationshipIds?: string[];
    limit: number;
    cursor?: string;
};

async function getScopedSources(
    graphId: string,
    embeddingModel: EmbeddingModelV3,
    { query, keywords, files, entityIds: entities, relationshipIds: relationships, limit, cursor }: GetScopedSourcesArgs
) {
    const fileIds = uniqueTerms(files ?? []);
    const entityIds = uniqueTerms(entities ?? []);
    const relationshipIds = uniqueTerms(relationships ?? []);
    const text = query?.trim() ?? "";
    const terms = uniqueTerms([text, ...(keywords ?? [])]);

    if (terms.length === 0) {
        const clauses = [eq(sourcesTable.active, true), eq(filesTable.graphId, graphId)];

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
    const queryEmbedding = text
        ? (
              await withAiSlot("embedding", () =>
                  embed({
                      model: embeddingModel,
                      value: text,
                  })
              )
          ).embedding
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
            ranked.semantic_score >= ${doubleLiteral(MIN_SEMANTIC_SCORE)}
            or ranked.keyword_boost >= ${doubleLiteral(MIN_KEYWORD_BOOST)}
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

export const getEntitySourcesTool = (graphId: string, embeddingModel: EmbeddingModelV3) =>
    tool({
        description:
            "Final grounding tool for entities. Use only after identifying entity IDs. When you provide a refinement query, semantic search is primary and keywords boost exact file or source text matches. The returned source IDs are the citation IDs that the final answer must cite.",
        inputSchema: getEntitySourcesSchema,
        execute: ({ query, keywords, files, entityIds, limit, cursor }) =>
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
                () => getScopedSources(graphId, embeddingModel, { query, keywords, files, entityIds, limit, cursor })
            ),
    });

export const getRelationshipSourcesTool = (graphId: string, embeddingModel: EmbeddingModelV3) =>
    tool({
        description:
            "Final grounding tool for relationships. Use only after identifying relationship IDs. When you provide a refinement query, semantic search is primary and keywords boost exact file or source text matches. The returned source IDs are the citation IDs that the final answer must cite.",
        inputSchema: getRelationshipSourcesSchema,
        execute: ({ query, keywords, files, relationshipIds, limit, cursor }) =>
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
                    })
            ),
    });

const tools = {
    getEntitySourcesTool,
    getRelationshipSourcesTool,
};

export default tools;
