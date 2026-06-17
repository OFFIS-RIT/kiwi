import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { db } from "@kiwi/db";
import { graphTable } from "@kiwi/db/tables/graph";
import type { GraphPatchFields, GraphPatchSuccessData } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES, internalServerError, makeApiError, noChangesError } from "@kiwi/contracts/errors";
import { assertCanPatchGraph, selectGraphFields, type GraphRecord } from "../../lib/graph/access";
import type { AuthUser } from "../../middleware/auth";
import { error as logError } from "@kiwi/logger";
import { tryApiPromise } from "../_shared/api-effect";

export function patchGraph(input: { user: AuthUser; graphId: string; body: GraphPatchFields }) {
    return tryApiPromise(async (): Promise<GraphPatchSuccessData> => {
        const existingGraph = await Effect.runPromise(assertCanPatchGraph(input.user, input.graphId));
        const name = input.body.name?.trim();
        const description = input.body.description === undefined ? undefined : input.body.description || null;
        const hidden = input.body.hidden === undefined ? undefined : input.body.hidden === true || input.body.hidden === "true";

        if (input.body.name !== undefined && !name) {
            throw makeApiError(400, API_ERROR_CODES.INVALID_NAME, "Invalid name");
        }

        const updateData: Partial<Pick<GraphRecord, "name" | "description" | "hidden">> = {};
        if (name !== undefined && name !== existingGraph.name) {
            updateData.name = name;
        }
        if (description !== undefined && description !== existingGraph.description) {
            updateData.description = description;
        }
        if (hidden !== undefined && hidden !== existingGraph.hidden) {
            updateData.hidden = hidden;
        }
        if (Object.keys(updateData).length === 0) {
            throw noChangesError();
        }

        try {
            const [graph] = await db
                .update(graphTable)
                .set(updateData)
                .where(eq(graphTable.id, existingGraph.id))
                .returning(selectGraphFields);

            return { graph: graph ?? existingGraph };
        } catch (dbPatchError) {
            logError("graph patch failed during database update", {
                graphId: existingGraph.id,
                error: dbPatchError,
            });
            throw internalServerError();
        }
    });
}
