import { db } from "@kiwi/db";
import type { EmbeddingModelV3 } from "@ai-sdk/provider";
import { entityTable, relationshipTable } from "@kiwi/db/tables/graph";
import { and, asc, cosineDistance, eq, gt, inArray, or, sql } from "drizzle-orm";
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

type SearchRelationshipRow = {
    id: string;
    sourceId: string;
    targetId: string;
    sourceName: string;
    targetName: string;
    description: string;
    rank: number;
    score: number;
};

function buildRelationshipKeywordBoostExpression(terms: string[]) {
    return greatest(
        terms.flatMap((term) => [
            sql`similarity(r.description, ${term})`,
            sql`similarity(coalesce(source_entity.name, ''), ${term})`,
            sql`similarity(coalesce(target_entity.name, ''), ${term})`,
        ])
    );
}

function buildRelationshipExactBoostExpression(terms: string[]) {
    return greatest(
        terms.map(
            (term) =>
                sql`case
                    when lower(coalesce(source_entity.name, '')) = lower(${term}) then ${doubleLiteral(EXACT_BOOST)}
                    when lower(coalesce(target_entity.name, '')) = lower(${term}) then ${doubleLiteral(EXACT_BOOST)}
                    when coalesce(source_entity.name, '') ilike ${`${term}%`} then ${doubleLiteral(PREFIX_BOOST)}
                    when coalesce(target_entity.name, '') ilike ${`${term}%`} then ${doubleLiteral(PREFIX_BOOST)}
                    else 0::double precision
                end`
        )
    );
}

function buildRelationshipFileScopeExpression(fileIds: string[]) {
    if (fileIds.length === 0) {
        return sql``;
    }

    return sql`
        and exists (
            select 1
            from sources source
            inner join text_units text_unit on text_unit.id = source.text_unit_id
            where source.relationship_id = r.id
              and text_unit.file_id in (${sql.join(
                  fileIds.map((fileId) => sql`${fileId}`),
                  sql`, `
              )})
        )
    `;
}

function toSearchRelationshipRows(rows: Record<string, unknown>[]): SearchRelationshipRow[] {
    return rows.map((row) => ({
        id: String(row.id ?? ""),
        sourceId: String(row.sourceId ?? ""),
        targetId: String(row.targetId ?? ""),
        sourceName: String(row.sourceName ?? "Unknown"),
        targetName: String(row.targetName ?? "Unknown"),
        description: String(row.description ?? ""),
        rank: Number(row.rank ?? 0),
        score: Number(row.score ?? 0),
    }));
}

function formatRelationshipList(
    rows: Array<
        Pick<
            SearchRelationshipRow,
            "id" | "sourceId" | "targetId" | "sourceName" | "targetName" | "description" | "rank"
        >
    >
) {
    return rows.map(
        (row) =>
            `- ${row.id}, ${row.sourceId} ${row.sourceName} -> ${row.targetId} ${row.targetName}, ${truncateWords(row.description) || "No description"}, rank ${row.rank}`
    );
}

const searchRelationshipsSchema = z.object({
    query: z
        .string()
        .describe(
            "Use a short phrase, relation label, topic, or pair of names to find matching relationships by description or connected entities."
        ),
    keywords: z
        .array(z.string())
        .describe("Optional extra names or terms when the main query is too broad or ambiguous.")
        .optional(),
    files: z
        .array(z.string())
        .describe("Optional file IDs to only search relationships supported by sources from those files.")
        .optional(),
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of relationships to return."),
    cursor: z.string().describe("Pagination cursor from a previous result page.").optional(),
});

export const searchRelationshipsTool = (graphId: string, embeddingModel: EmbeddingModelV3) =>
    tool({
        description:
            "Use when you need relationship IDs before calling the source tool, or when the important fact is the connection itself rather than a single entity. Semantic search is primary, with keyword terms boosting connected entity names and relation labels.",
        inputSchema: searchRelationshipsSchema,
        execute: ({ query, keywords, files, limit, cursor }) =>
            runToolSafely(
                {
                    title: "Relationships",
                    name: "search_relationships",
                    hints: [
                        "retry with a shorter query or fewer keywords",
                        "if you already know entity IDs, use get_relationships instead",
                    ],
                },
                { query, keywords, files, limit, cursor },
                async () => {
                    const text = query.trim();
                    const terms = uniqueTerms([...(keywords ?? []), text]);
                    const fileIds = uniqueTerms(files ?? []);
                    const next = decodeCursor(cursor, "relationship search");
                    const { embedding } = await withAiSlot("embedding", () =>
                        embed({
                            model: embeddingModel,
                            value: text,
                        })
                    );
                    const fileScope = buildRelationshipFileScopeExpression(fileIds);
                    const keywordBoost = buildRelationshipKeywordBoostExpression(terms);
                    const exactBoost = buildRelationshipExactBoostExpression(terms);
                    const semanticScore = sql<number>`greatest(0::double precision, 1 - (${cosineDistance(sql`r.embedding`, embedding)}))`;
                    const score = sql`${semanticScore} + (${keywordBoost} * ${doubleLiteral(KEYWORD_WEIGHT)}) + ${exactBoost}`;
                    const cursorFilter = next
                        ? sql`
                              and (
                                  ranked.score < ${next.score}
                                  or (ranked.score = ${next.score} and ranked.id > ${next.id})
                              )
                          `
                        : sql``;
                    const result = await db.execute(sql<SearchRelationshipRow>`
                        with ranked as (
                            select
                                r.id,
                                r.source_id as "sourceId",
                                r.target_id as "targetId",
                                coalesce(source_entity.name, 'Unknown') as "sourceName",
                                coalesce(target_entity.name, 'Unknown') as "targetName",
                                r.description,
                                r.rank,
                                ${semanticScore} as semantic_score,
                                ${keywordBoost} as keyword_boost,
                                ${exactBoost} as exact_boost,
                                ${score} as score
                            from relationships r
                            left join entities source_entity on source_entity.id = r.source_id
                            left join entities target_entity on target_entity.id = r.target_id
                            where r.graph_id = ${graphId}
                              and r.active = true
                              ${fileScope}
                        )
                        select
                            ranked.id,
                            ranked."sourceId",
                            ranked."targetId",
                            ranked."sourceName",
                            ranked."targetName",
                            ranked.description,
                            ranked.rank,
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
                    const relationships = toSearchRelationshipRows(result.rows);

                    const hasMore = relationships.length > limit;
                    const items = hasMore ? relationships.slice(0, limit) : relationships;

                    return [
                        "## Relationships",
                        ...(items.length > 0 ? formatRelationshipList(items) : ["- none"]),
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

const getRelationshipsSchema = z.object({
    entityIds: z
        .array(z.string())
        .describe("Entity IDs whose direct incoming or outgoing relationships you want to inspect."),
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of relationships to return."),
    cursor: z.string().describe("Pagination cursor from a previous result page.").optional(),
});

export const getRelationshipsTool = (graphId: string) =>
    tool({
        description:
            "Use when you already have entity IDs and want the direct edges touching them. Good for understanding how a small set of entities is connected.",
        inputSchema: getRelationshipsSchema,
        execute: ({ entityIds, limit, cursor }) =>
            runToolSafely(
                {
                    title: "Relationships",
                    name: "get_relationships",
                    hints: [
                        "retry with a smaller set of entity IDs",
                        "if you need a broader lookup first, use search_relationships",
                    ],
                },
                { entityIds, limit, cursor },
                async () => {
                    const ids = uniqueTerms(entityIds);

                    if (ids.length === 0) {
                        return "## Relationships\n- none";
                    }

                    const clauses = [
                        eq(relationshipTable.graphId, graphId),
                        eq(relationshipTable.active, true),
                        or(inArray(relationshipTable.sourceId, ids), inArray(relationshipTable.targetId, ids))!,
                    ];

                    if (cursor) {
                        clauses.push(gt(relationshipTable.id, cursor));
                    }

                    const relationships = await db
                        .select({
                            id: relationshipTable.id,
                            sourceId: relationshipTable.sourceId,
                            targetId: relationshipTable.targetId,
                            description: relationshipTable.description,
                            rank: relationshipTable.rank,
                        })
                        .from(relationshipTable)
                        .where(and(...clauses))
                        .orderBy(asc(relationshipTable.id))
                        .limit(limit + 1);

                    const hasMore = relationships.length > limit;
                    const items = hasMore ? relationships.slice(0, limit) : relationships;
                    const entityLookupIds = [...new Set(items.flatMap((row) => [row.sourceId, row.targetId]))];
                    const entities = entityLookupIds.length
                        ? await db
                              .select({
                                  id: entityTable.id,
                                  name: entityTable.name,
                                  type: entityTable.type,
                              })
                              .from(entityTable)
                              .where(inArray(entityTable.id, entityLookupIds))
                        : [];
                    const entityMap = new Map(entities.map((row) => [row.id, row]));

                    return [
                        "## Relationships",
                        ...(items.length > 0
                            ? items.map((row) => {
                                  const description = truncateWords(row.description);
                                  const source = entityMap.get(row.sourceId);
                                  const target = entityMap.get(row.targetId);

                                  return `- ${row.id}, ${row.sourceId} ${source?.name ?? "Unknown"} -> ${row.targetId} ${target?.name ?? "Unknown"}, ${description || "No description"}, rank ${row.rank}`;
                              })
                            : ["- none"]),
                        ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
                    ].join("\n");
                }
            ),
    });

const getNeighbourSchema = z.object({
    entityId: z.string().describe("Entity ID whose direct neighbors you want to discover."),
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of neighbors to return."),
    cursor: z.string().describe("Pagination cursor from a previous result page.").optional(),
});

export const getNeighboursTool = (graphId: string) =>
    tool({
        description:
            "Use when you have one entity ID and want the entities directly connected to it, along with the relationship that connects them.",
        inputSchema: getNeighbourSchema,
        execute: ({ entityId, limit, cursor }) =>
            runToolSafely(
                {
                    title: "Neighbours",
                    name: "get_entity_neighbours",
                    hints: ["retry with one confirmed entity ID", "if the entity is unknown, search_entities first"],
                },
                { entityId, limit, cursor },
                async () => {
                    const clauses = [
                        eq(relationshipTable.graphId, graphId),
                        eq(relationshipTable.active, true),
                        or(eq(relationshipTable.sourceId, entityId), eq(relationshipTable.targetId, entityId))!,
                    ];

                    if (cursor) {
                        clauses.push(gt(relationshipTable.id, cursor));
                    }

                    const relationships = await db
                        .select({
                            id: relationshipTable.id,
                            sourceId: relationshipTable.sourceId,
                            targetId: relationshipTable.targetId,
                            description: relationshipTable.description,
                            rank: relationshipTable.rank,
                        })
                        .from(relationshipTable)
                        .where(and(...clauses))
                        .orderBy(asc(relationshipTable.id))
                        .limit(limit + 1);

                    const hasMore = relationships.length > limit;
                    const items = hasMore ? relationships.slice(0, limit) : relationships;
                    const neighbourIds = [
                        ...new Set(items.map((row) => (row.sourceId === entityId ? row.targetId : row.sourceId))),
                    ];
                    const entities = neighbourIds.length
                        ? await db
                              .select({
                                  id: entityTable.id,
                                  name: entityTable.name,
                                  type: entityTable.type,
                                  description: entityTable.description,
                              })
                              .from(entityTable)
                              .where(inArray(entityTable.id, neighbourIds))
                        : [];
                    const entityMap = new Map(entities.map((row) => [row.id, row]));

                    return [
                        "## Neighbours",
                        ...(items.length > 0
                            ? items.map((row) => {
                                  const neighbourId = row.sourceId === entityId ? row.targetId : row.sourceId;
                                  const neighbour = entityMap.get(neighbourId);
                                  const relationship = truncateWords(row.description, 30);
                                  const description = truncateWords(neighbour?.description ?? "", 20);

                                  return `- ${neighbourId}, ${neighbour?.name ?? "Unknown"}, ${neighbour?.type ?? "Unknown"}, ${description || "No description"}; via ${row.id}, ${relationship || "No relationship description"}, rank ${row.rank}`;
                              })
                            : ["- none"]),
                        ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
                    ].join("\n");
                }
            ),
    });

const getPathBetweenSchema = z.object({
    sourceEntityId: z.string().describe("Starting entity ID."),
    targetEntityId: z.string().describe("Target entity ID."),
});

export const getPathBetweenTool = (graphId: string) =>
    tool({
        description:
            "Use when you have two entity IDs and want one short connection path between them. This searches direct graph hops and returns a compact path summary.",
        inputSchema: getPathBetweenSchema,
        execute: ({ sourceEntityId, targetEntityId }) =>
            runToolSafely(
                {
                    title: "Path",
                    name: "get_path_between_entities",
                    hints: [
                        "retry only after both entity IDs are confirmed",
                        "if either entity is uncertain, search_entities first",
                    ],
                },
                { sourceEntityId, targetEntityId },
                async () => {
                    if (sourceEntityId === targetEntityId) {
                        const [entity] = await db
                            .select({
                                id: entityTable.id,
                                name: entityTable.name,
                                type: entityTable.type,
                            })
                            .from(entityTable)
                            .where(and(eq(entityTable.graphId, graphId), eq(entityTable.id, sourceEntityId)))
                            .limit(1);

                        return [
                            "## Path",
                            `- ${entity?.id ?? sourceEntityId}, ${entity?.name ?? "Unknown"}, ${entity?.type ?? "Unknown"}`,
                        ].join("\n");
                    }

                    const maxDepth = 5;
                    const visited = new Set([sourceEntityId]);
                    const previous = new Map<string, { entityId: string; relationshipId: string }>();
                    let frontier = [sourceEntityId];

                    for (
                        let depth = 0;
                        depth < maxDepth && frontier.length > 0 && !visited.has(targetEntityId);
                        depth += 1
                    ) {
                        const relationships = await db
                            .select({
                                id: relationshipTable.id,
                                sourceId: relationshipTable.sourceId,
                                targetId: relationshipTable.targetId,
                            })
                            .from(relationshipTable)
                            .where(
                                and(
                                    eq(relationshipTable.graphId, graphId),
                                    eq(relationshipTable.active, true),
                                    or(
                                        inArray(relationshipTable.sourceId, frontier),
                                        inArray(relationshipTable.targetId, frontier)
                                    )!
                                )
                            );

                        const nextFrontier: string[] = [];

                        for (const relationship of relationships) {
                            if (frontier.includes(relationship.sourceId) && !visited.has(relationship.targetId)) {
                                visited.add(relationship.targetId);
                                previous.set(relationship.targetId, {
                                    entityId: relationship.sourceId,
                                    relationshipId: relationship.id,
                                });
                                nextFrontier.push(relationship.targetId);
                            }

                            if (frontier.includes(relationship.targetId) && !visited.has(relationship.sourceId)) {
                                visited.add(relationship.sourceId);
                                previous.set(relationship.sourceId, {
                                    entityId: relationship.targetId,
                                    relationshipId: relationship.id,
                                });
                                nextFrontier.push(relationship.sourceId);
                            }
                        }

                        frontier = [...new Set(nextFrontier)];
                    }

                    if (!visited.has(targetEntityId)) {
                        return `## Path\n- none found within ${maxDepth} hops`;
                    }

                    const pathEntityIds = [targetEntityId];
                    const pathRelationshipIds: string[] = [];
                    let currentEntityId = targetEntityId;

                    while (currentEntityId !== sourceEntityId) {
                        const step = previous.get(currentEntityId);

                        if (!step) {
                            break;
                        }

                        pathRelationshipIds.unshift(step.relationshipId);
                        pathEntityIds.unshift(step.entityId);
                        currentEntityId = step.entityId;
                    }

                    const entities = await db
                        .select({
                            id: entityTable.id,
                            name: entityTable.name,
                            type: entityTable.type,
                        })
                        .from(entityTable)
                        .where(inArray(entityTable.id, pathEntityIds));
                    const relationships = pathRelationshipIds.length
                        ? await db
                              .select({
                                  id: relationshipTable.id,
                                  description: relationshipTable.description,
                              })
                              .from(relationshipTable)
                              .where(inArray(relationshipTable.id, pathRelationshipIds))
                        : [];
                    const entityMap = new Map(entities.map((row) => [row.id, row]));
                    const relationshipMap = new Map(relationships.map((row) => [row.id, row]));
                    const lines = ["## Path"];

                    for (const [index, entityId] of pathEntityIds.entries()) {
                        const entity = entityMap.get(entityId);
                        lines.push(`- ${entityId}, ${entity?.name ?? "Unknown"}, ${entity?.type ?? "Unknown"}`);

                        if (index < pathRelationshipIds.length) {
                            const relationship = relationshipMap.get(pathRelationshipIds[index]!);
                            const description = truncateWords(relationship?.description ?? "", 30);
                            lines.push(
                                `- ${pathRelationshipIds[index]}, ${description || "No relationship description"}`
                            );
                        }
                    }

                    return lines.join("\n");
                }
            ),
    });

const tools = {
    searchRelationshipsTool,
    getRelationshipsTool,
    getNeighboursTool,
    getPathBetweenTool,
};

export default tools;
