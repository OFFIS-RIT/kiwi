import { db } from "@kiwi/db";
import { filesTable, sourcesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, gt, ilike, inArray, or } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";

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

export const getSourcesTool = (graphId: string) =>
    tool({
        description:
            "Final grounding tool. Use only after researching entities or relationships first. The returned source IDs are the citation IDs that the final answer must cite.",
        inputSchema: getSourcesSchema,
        execute: async ({ query, keywords, files, entityIds, relationshipIds, limit, cursor }) => {
            const fileIds = [...new Set((files ?? []).map((value) => value.trim()).filter(Boolean))];
            const scopedEntityIds = [...new Set((entityIds ?? []).map((value) => value.trim()).filter(Boolean))];
            const scopedRelationshipIds = [
                ...new Set((relationshipIds ?? []).map((value) => value.trim()).filter(Boolean)),
            ];
            const terms = [...new Set([query ?? "", ...(keywords ?? [])].map((value) => value.trim()).filter(Boolean))];

            if (scopedEntityIds.length === 0 && scopedRelationshipIds.length === 0) {
                return [
                    "## Sources",
                    "Use source IDs from this tool as citations in the final answer.",
                    "- hint: do entity and relationship research first, then call this tool with at least one entityId or relationshipId.",
                ].join("\n");
            }

            const clauses = [eq(sourcesTable.active, true), eq(filesTable.graphId, graphId)];

            if (cursor) {
                clauses.push(gt(sourcesTable.id, cursor));
            }

            if (fileIds.length > 0) {
                clauses.push(inArray(textUnitTable.fileId, fileIds));
            }

            if (scopedEntityIds.length > 0 || scopedRelationshipIds.length > 0) {
                const idClauses = [];

                if (scopedEntityIds.length > 0) {
                    idClauses.push(inArray(sourcesTable.entityId, scopedEntityIds));
                }

                if (scopedRelationshipIds.length > 0) {
                    idClauses.push(inArray(sourcesTable.relationshipId, scopedRelationshipIds));
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

            if (terms.length > 0) {
                const termClauses = terms.flatMap((term) => [
                    ilike(sourcesTable.description, `%${term}%`),
                    ilike(textUnitTable.text, `%${term}%`),
                    ilike(filesTable.name, `%${term}%`),
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
                ...(items.length > 0
                    ? items.map((row) => {
                          const normalizedDescription = row.description.replace(/\s+/g, " ").trim();
                          const normalizedExcerpt = row.text.replace(/\s+/g, " ").trim();
                          const excerptWords = normalizedExcerpt.length > 0 ? normalizedExcerpt.split(" ") : [];
                          const shortExcerpt =
                              excerptWords.length > 40
                                  ? `${excerptWords.slice(0, 40).join(" ")}...`
                                  : normalizedExcerpt;
                          const subject = row.entityId
                              ? `entity ${row.entityId}`
                              : row.relationshipId
                                ? `relationship ${row.relationshipId}`
                                : "unlinked";

                          return `- ${row.id}, ${subject}, file ${row.fileId} ${row.fileName}, ${normalizedDescription || "No description"}, excerpt: ${shortExcerpt || "No excerpt"}`;
                      })
                    : ["- none"]),
                ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
            ].join("\n");
        },
    });

const tools = {
    getSourcesTool,
};

export default tools;
