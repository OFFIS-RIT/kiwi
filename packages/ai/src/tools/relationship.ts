import { db } from "@kiwi/db";
import { entityTable, relationshipTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, exists, gt, ilike, inArray, or } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";

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

export const searchRelationshipsTool = (graphId: string) =>
    tool({
        description:
            "Use when you need relationship IDs before calling the source tool, or when the important fact is the connection itself rather than a single entity.",
        inputSchema: searchRelationshipsSchema,
        execute: async ({ query, keywords, files, limit, cursor }) => {
            const terms = [...new Set([query, ...(keywords ?? [])].map((value) => value.trim()).filter(Boolean))];
            const fileIds = [...new Set((files ?? []).map((value) => value.trim()).filter(Boolean))];
            const clauses = [eq(relationshipTable.graphId, graphId), eq(relationshipTable.active, true)];

            if (cursor) {
                clauses.push(gt(relationshipTable.id, cursor));
            }

            if (terms.length > 0) {
                const descriptionClauses = terms.map((term) => ilike(relationshipTable.description, `%${term}%`));
                const sourceEntityClauses = terms.flatMap((term) => [
                    ilike(entityTable.name, `%${term}%`),
                    ilike(entityTable.type, `%${term}%`),
                    ilike(entityTable.description, `%${term}%`),
                ]);
                const targetEntityClauses = terms.flatMap((term) => [
                    ilike(entityTable.name, `%${term}%`),
                    ilike(entityTable.type, `%${term}%`),
                    ilike(entityTable.description, `%${term}%`),
                ]);
                const sourceEntityMatch =
                    sourceEntityClauses.length === 1
                        ? sourceEntityClauses[0]
                        : sourceEntityClauses.length > 1
                          ? or(...sourceEntityClauses)
                          : undefined;
                const targetEntityMatch =
                    targetEntityClauses.length === 1
                        ? targetEntityClauses[0]
                        : targetEntityClauses.length > 1
                          ? or(...targetEntityClauses)
                          : undefined;
                const searchClauses = [...descriptionClauses];

                if (sourceEntityMatch) {
                    searchClauses.push(
                        exists(
                            db
                                .select({ id: entityTable.id })
                                .from(entityTable)
                                .where(
                                    and(
                                        eq(entityTable.id, relationshipTable.sourceId),
                                        eq(entityTable.graphId, graphId),
                                        sourceEntityMatch
                                    )
                                )
                        )
                    );
                }

                if (targetEntityMatch) {
                    searchClauses.push(
                        exists(
                            db
                                .select({ id: entityTable.id })
                                .from(entityTable)
                                .where(
                                    and(
                                        eq(entityTable.id, relationshipTable.targetId),
                                        eq(entityTable.graphId, graphId),
                                        targetEntityMatch
                                    )
                                )
                        )
                    );
                }

                if (searchClauses.length === 1) {
                    clauses.push(searchClauses[0]!);
                } else {
                    const combinedSearchClause = or(...searchClauses);

                    if (combinedSearchClause) {
                        clauses.push(combinedSearchClause);
                    }
                }
            }

            if (fileIds.length > 0) {
                clauses.push(
                    exists(
                        db
                            .select({ id: sourcesTable.id })
                            .from(sourcesTable)
                            .innerJoin(textUnitTable, eq(textUnitTable.id, sourcesTable.textUnitId))
                            .where(
                                and(
                                    eq(sourcesTable.relationshipId, relationshipTable.id),
                                    inArray(textUnitTable.fileId, fileIds)
                                )
                            )
                    )
                );
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
                          const normalized = row.description.replace(/\s+/g, " ").trim();
                          const words = normalized.length > 0 ? normalized.split(" ") : [];
                          const shortDescription =
                              words.length > 40 ? `${words.slice(0, 40).join(" ")}...` : normalized;
                          const source = entityMap.get(row.sourceId);
                          const target = entityMap.get(row.targetId);

                          return `- ${row.id}, ${row.sourceId} ${source?.name ?? "Unknown"} -> ${row.targetId} ${target?.name ?? "Unknown"}, ${shortDescription || "No description"}, rank ${row.rank}`;
                      })
                    : ["- none"]),
                ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
            ].join("\n");
        },
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
        execute: async ({ entityIds, limit, cursor }) => {
            const ids = [...new Set(entityIds.map((value) => value.trim()).filter(Boolean))];

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
                          const normalized = row.description.replace(/\s+/g, " ").trim();
                          const words = normalized.length > 0 ? normalized.split(" ") : [];
                          const shortDescription =
                              words.length > 40 ? `${words.slice(0, 40).join(" ")}...` : normalized;
                          const source = entityMap.get(row.sourceId);
                          const target = entityMap.get(row.targetId);

                          return `- ${row.id}, ${row.sourceId} ${source?.name ?? "Unknown"} -> ${row.targetId} ${target?.name ?? "Unknown"}, ${shortDescription || "No description"}, rank ${row.rank}`;
                      })
                    : ["- none"]),
                ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
            ].join("\n");
        },
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
        execute: async ({ entityId, limit, cursor }) => {
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
                          const normalizedRelationship = row.description.replace(/\s+/g, " ").trim();
                          const relationshipWords =
                              normalizedRelationship.length > 0 ? normalizedRelationship.split(" ") : [];
                          const shortRelationship =
                              relationshipWords.length > 30
                                  ? `${relationshipWords.slice(0, 30).join(" ")}...`
                                  : normalizedRelationship;
                          const normalizedEntityDescription = neighbour?.description.replace(/\s+/g, " ").trim() ?? "";
                          const entityWords =
                              normalizedEntityDescription.length > 0 ? normalizedEntityDescription.split(" ") : [];
                          const shortEntityDescription =
                              entityWords.length > 20
                                  ? `${entityWords.slice(0, 20).join(" ")}...`
                                  : normalizedEntityDescription;

                          return `- ${neighbourId}, ${neighbour?.name ?? "Unknown"}, ${neighbour?.type ?? "Unknown"}, ${shortEntityDescription || "No description"}; via ${row.id}, ${shortRelationship || "No relationship description"}, rank ${row.rank}`;
                      })
                    : ["- none"]),
                ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
            ].join("\n");
        },
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
        execute: async ({ sourceEntityId, targetEntityId }) => {
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

            for (let depth = 0; depth < maxDepth && frontier.length > 0 && !visited.has(targetEntityId); depth += 1) {
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
                    const normalized = relationship?.description.replace(/\s+/g, " ").trim() ?? "";
                    const words = normalized.length > 0 ? normalized.split(" ") : [];
                    const shortDescription = words.length > 30 ? `${words.slice(0, 30).join(" ")}...` : normalized;
                    lines.push(`- ${pathRelationshipIds[index]}, ${shortDescription || "No relationship description"}`);
                }
            }

            return lines.join("\n");
        },
    });

const tools = {
    searchRelationshipsTool,
    getRelationshipsTool,
    getNeighboursTool,
    getPathBetweenTool,
};

export default tools;
