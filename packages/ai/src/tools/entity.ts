import { db } from "@kiwi/db";
import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import { entityTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, exists, gt, inArray, sql } from "drizzle-orm";
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
import z from "zod";

type SearchEntityRow = {
    id: string;
    name: string;
    type: string;
    description: string;
    score: number;
};

function toSearchEntityRows(rows: Record<string, unknown>[]): SearchEntityRow[] {
    return rows.map((row) => ({
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        type: String(row.type ?? ""),
        description: String(row.description ?? ""),
        score: Number(row.score ?? 0),
    }));
}

function buildKeywordBoostExpression(terms: string[]) {
    return greatest(terms.map((term) => sql`similarity(e.name, ${term})`));
}

function buildExactBoostExpression(terms: string[]) {
    return greatest(
        terms.map(
            (term) =>
                sql`case
                    when lower(e.name) = lower(${term}) then ${EXACT_BOOST}
                    when e.name ilike ${`${term}%`} then ${PREFIX_BOOST}
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
        and exists (
            select 1
            from sources source
            inner join text_units text_unit on text_unit.id = source.text_unit_id
            where source.entity_id = e.id
              and text_unit.file_id in (${sql.join(
                  fileIds.map((fileId) => sql`${fileId}`),
                  sql`, `
              )})
        )
    `;
}

function formatEntityList(rows: Array<Pick<SearchEntityRow, "id" | "name" | "type" | "description">>) {
    return rows.map((row) => `- ${row.id}, ${row.name}, ${row.type}, ${truncateWords(row.description) || "No description"}`);
}

const searchEntitiesSchema = z.object({
    query: z
        .string()
        .describe("Use a short phrase, name, alias, or topic to find matching entities by name, type, or description."),
    keywords: z
        .array(z.string())
        .describe("Optional extra names or terms when the main query is too broad or ambiguous.")
        .optional(),
    files: z
        .array(z.string())
        .describe("Optional file IDs to only search entities that are supported by sources from those files.")
        .optional(),
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of entities to return."),
    cursor: z.string().describe("Pagination cursor from a previous result page.").optional(),
});

export const searchEntityTool = (graphId: string, embeddingModel: EmbeddingModelV3) =>
    tool({
        description:
            "Use when you need entity IDs before calling relationship or source tools. Semantic search is primary, with keyword terms used to boost exact or near-exact name matches.",
        inputSchema: searchEntitiesSchema,
        execute: async ({ query, keywords, files, limit, cursor }) => {
            const text = query.trim();
            const terms = normalizeTerms([...(keywords ?? []), text]);
            const fileIds = normalizeTerms(files ?? []);
            const next = decodeCursor(cursor, "entity search");
            const { embedding } = await withAiSlot("embedding", () =>
                embed({
                    model: embeddingModel,
                    value: text,
                })
            );
            const queryVector = JSON.stringify(embedding);
            const fileScope = buildFileScopeExpression(fileIds);
            const keywordBoost = buildKeywordBoostExpression(terms);
            const exactBoost = buildExactBoostExpression(terms);
            const semanticScore = sql`greatest(0::double precision, 1 - (e.embedding <=> ${queryVector}::vector))`;
            const score = sql`${semanticScore} + (${keywordBoost} * ${KEYWORD_WEIGHT}) + ${exactBoost}`;
            const cursorFilter = next
                ? sql`
                    and (
                        ranked.score < ${next.score}
                        or (ranked.score = ${next.score} and ranked.id > ${next.id})
                    )
                `
                : sql``;
            const result = await db.execute(sql<SearchEntityRow>`
                with ranked as (
                    select
                        e.id,
                        e.name,
                        e.type,
                        e.description,
                        ${semanticScore} as semantic_score,
                        ${keywordBoost} as keyword_boost,
                        ${exactBoost} as exact_boost,
                        ${score} as score
                    from entities e
                    where e.graph_id = ${graphId}
                      and e.active = true
                      ${fileScope}
                )
                select
                    ranked.id,
                    ranked.name,
                    ranked.type,
                    ranked.description,
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
            const rows = toSearchEntityRows(result.rows);

            const hasMore = rows.length > limit;
            const items = hasMore ? rows.slice(0, limit) : rows;
            const lines = formatEntityList(items);

            return [
                "## Entities",
                ...(lines.length > 0 ? lines : ["- none"]),
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
        },
    });

const listEntitiesSchema = z.object({
    files: z
        .array(z.string())
        .describe("Optional file IDs to only list entities supported by sources from those files.")
        .optional(),
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of entities to return."),
    cursor: z.string().describe("Pagination cursor from a previous result page.").optional(),
});

export const listEntitiesTool = (graphId: string) =>
    tool({
        description:
            "Use when you want a broad unranked scan of entity IDs in the graph or inside specific files and do not yet know which entities matter.",
        inputSchema: listEntitiesSchema,
        execute: async ({ files, limit, cursor }) => {
            const fileIds = normalizeTerms(files ?? []);
            const clauses = [eq(entityTable.graphId, graphId), eq(entityTable.active, true)];

            if (cursor) {
                clauses.push(gt(entityTable.id, cursor));
            }

            if (fileIds.length > 0) {
                clauses.push(
                    exists(
                        db
                            .select({ id: sourcesTable.id })
                            .from(sourcesTable)
                            .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                            .where(
                                and(eq(sourcesTable.entityId, entityTable.id), inArray(textUnitTable.fileId, fileIds))
                            )
                    )
                );
            }

            const rows = await db
                .select({
                    id: entityTable.id,
                    name: entityTable.name,
                    type: entityTable.type,
                    description: entityTable.description,
                })
                .from(entityTable)
                .where(and(...clauses))
                .orderBy(asc(entityTable.id))
                .limit(limit + 1);

            const hasMore = rows.length > limit;
            const items = hasMore ? rows.slice(0, limit) : rows;
            const lines = formatEntityList(items);

            return [
                "## Entities",
                ...(lines.length > 0 ? lines : ["- none"]),
                ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
            ].join("\n");
        },
    });

const tools = {
    searchEntityTool,
    listEntitiesTool,
};

export default tools;
