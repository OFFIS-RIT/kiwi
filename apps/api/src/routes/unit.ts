import { db } from "@kiwi/db";
import { filesTable, textUnitTable } from "@kiwi/db/tables/graph";
import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { authMiddleware } from "../middleware/auth";
import { requirePermissions } from "../middleware/permissions";
import { API_ERROR_CODES, errorResponse, successResponse } from "../types";
import { assertCanViewGraph } from "./graph";

function mapUnitError(status: (code: number, body: unknown) => unknown, error: unknown) {
    if (!(error instanceof Error)) {
        return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
    }

    if (error.message === API_ERROR_CODES.TEXT_UNIT_NOT_FOUND) {
        return status(404, errorResponse("Text unit not found", API_ERROR_CODES.TEXT_UNIT_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.GRAPH_NOT_FOUND) {
        return status(404, errorResponse("Graph not found", API_ERROR_CODES.GRAPH_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.GROUP_NOT_FOUND) {
        return status(404, errorResponse("Group not found", API_ERROR_CODES.GROUP_NOT_FOUND));
    }

    if (error.message === API_ERROR_CODES.INVALID_GRAPH_OWNER) {
        return status(400, errorResponse("Invalid graph owner chain", API_ERROR_CODES.INVALID_GRAPH_OWNER));
    }

    if (error.message === API_ERROR_CODES.FORBIDDEN) {
        return status(403, errorResponse("Forbidden", API_ERROR_CODES.FORBIDDEN));
    }

    return status(500, errorResponse("Internal server error", API_ERROR_CODES.INTERNAL_SERVER_ERROR));
}

export const unitRoute = new Elysia({ prefix: "/units" }).use(authMiddleware).get(
    "/:unitId",
    async ({ params, user, status }) => {
        if (!user) {
            return status(401, errorResponse("Unauthorized", API_ERROR_CODES.UNAUTHORIZED));
        }

        try {
            const [unit] = await db
                .select({
                    id: textUnitTable.id,
                    project_file_id: textUnitTable.fileId,
                    text: textUnitTable.text,
                    created_at: textUnitTable.createdAt,
                    updated_at: textUnitTable.updatedAt,
                    graph_id: filesTable.graphId,
                })
                .from(textUnitTable)
                .innerJoin(filesTable, eq(filesTable.id, textUnitTable.fileId))
                .where(eq(textUnitTable.id, params.unitId))
                .limit(1);

            if (!unit) {
                throw new Error(API_ERROR_CODES.TEXT_UNIT_NOT_FOUND);
            }

            await assertCanViewGraph(user, unit.graph_id);

            return status(
                200,
                successResponse({
                    id: unit.id,
                    project_file_id: unit.project_file_id,
                    text: unit.text,
                    created_at: unit.created_at?.toISOString() ?? null,
                    updated_at: unit.updated_at?.toISOString() ?? null,
                })
            );
        } catch (error) {
            return mapUnitError(status, error);
        }
    },
    {
        params: t.Object({
            unitId: t.String(),
        }),
        beforeHandle: requirePermissions({
            graph: ["view"],
        }),
    }
);
