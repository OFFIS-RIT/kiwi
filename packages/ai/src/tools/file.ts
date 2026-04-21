import { db } from "@kiwi/db";
import { filesTable } from "@kiwi/db/tables/graph";
import { and, asc, eq, gt, ilike } from "drizzle-orm";
import { tool } from "ai";
import z from "zod";
import { runToolSafely } from "./lib/execute";

const listFilesSchema = z.object({
    name: z.string().describe("Optional partial file name when you need to find the right file ID first.").optional(),
    limit: z.number().min(1).max(50).default(10).describe("Maximum number of files to return."),
    cursor: z.string().describe("Pagination cursor from a previous result page.").optional(),
});

export const listFilesTool = (graphId: string) =>
    tool({
        description:
            "Use when you need file IDs to narrow other tools. Best for scanning the graph's files or finding a file by partial name.",
        inputSchema: listFilesSchema,
        execute: ({ name, limit, cursor }) =>
            runToolSafely(
                {
                    title: "Files",
                    name: "list_files",
                    hints: [
                        "retry without a cursor to restart the listing",
                        "use a shorter partial file name or omit the name filter",
                    ],
                },
                { name, limit, cursor },
                async () => {
                    const clauses = [eq(filesTable.graphId, graphId), eq(filesTable.deleted, false)];

                    if (cursor) {
                        clauses.push(gt(filesTable.id, cursor));
                    }

                    if (name?.trim()) {
                        clauses.push(ilike(filesTable.name, `%${name.trim()}%`));
                    }

                    const rows = await db
                        .select({
                            id: filesTable.id,
                            name: filesTable.name,
                            type: filesTable.type,
                            mimeType: filesTable.mimeType,
                            size: filesTable.size,
                            tokenCount: filesTable.tokenCount,
                        })
                        .from(filesTable)
                        .where(and(...clauses))
                        .orderBy(asc(filesTable.id))
                        .limit(limit + 1);

                    const hasMore = rows.length > limit;
                    const items = hasMore ? rows.slice(0, limit) : rows;

                    return [
                        "## Files",
                        ...(items.length > 0
                            ? items.map(
                                  (row) =>
                                      `- ${row.id}, ${row.name}, ${row.type}, ${row.mimeType}, ${row.size} bytes, ${row.tokenCount} tokens`
                              )
                            : ["- none"]),
                        ...(hasMore && items.length > 0 ? [``, `Next cursor: ${items[items.length - 1]?.id}`] : []),
                    ].join("\n");
                }
            ),
    });

const tools = {
    listFilesTool,
};

export default tools;
