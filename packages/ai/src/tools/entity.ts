import { db } from "@kiwi/db";
import { entityTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, exists, gt, ilike, inArray, or } from "drizzle-orm";
import { tool } from "ai";
import z from "zod";

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

export const searchEntityTool = (graphId: string) =>
    tool({
        description:
            "Use when you need entity IDs before calling relationship or source tools. Best for finding entities by name, alias, type, or a short topic phrase.",
        inputSchema: searchEntitiesSchema,
        execute: async ({ query, keywords, files, limit, cursor }) => {
            const terms = [...new Set([query, ...(keywords ?? [])].map((value) => value.trim()).filter(Boolean))];
            const fileIds = [...new Set((files ?? []).map((value) => value.trim()).filter(Boolean))];
            const clauses = [eq(entityTable.graphId, graphId), eq(entityTable.active, true)];

            if (cursor) {
                clauses.push(gt(entityTable.id, cursor));
            }

            if (terms.length > 0) {
                const termClauses = terms.flatMap((term) => [
                    ilike(entityTable.name, `%${term}%`),
                    ilike(entityTable.type, `%${term}%`),
                    ilike(entityTable.description, `%${term}%`),
                ]);

                if (termClauses.length === 1) {
                    clauses.push(termClauses[0]!);
                } else {
                    const combinedTermClause = or(...termClauses);

                    if (combinedTermClause) {
                        clauses.push(combinedTermClause);
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
            const lines = items.map((row) => {
                const normalized = row.description.replace(/\s+/g, " ").trim();
                const words = normalized.length > 0 ? normalized.split(" ") : [];
                const shortDescription = words.length > 40 ? `${words.slice(0, 40).join(" ")}...` : normalized;

                return `- ${row.id}, ${row.name}, ${row.type}, ${shortDescription || "No description"}`;
            });

            return [
                "## Entities",
                ...(lines.length > 0 ? lines : ["- none"]),
                ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
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
            "Use when you want a broad scan of entity IDs in the graph or inside specific files and do not yet know which entities matter.",
        inputSchema: listEntitiesSchema,
        execute: async ({ files, limit, cursor }) => {
            const fileIds = [...new Set((files ?? []).map((value) => value.trim()).filter(Boolean))];
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
            const lines = items.map((row) => {
                const normalized = row.description.replace(/\s+/g, " ").trim();
                const words = normalized.length > 0 ? normalized.split(" ") : [];
                const shortDescription = words.length > 40 ? `${words.slice(0, 40).join(" ")}...` : normalized;

                return `- ${row.id}, ${row.name}, ${row.type}, ${shortDescription || "No description"}`;
            });

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
