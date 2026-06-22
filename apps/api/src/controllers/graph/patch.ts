import { eq } from "@kiwi/db/drizzle";
import * as Effect from "effect/Effect";
import { tryDb } from "@kiwi/db/effect";
import { graphTable } from "@kiwi/db/tables/graph";
import type { GraphPatchFields } from "@kiwi/contracts/graphs";
import { API_ERROR_CODES, internalServerError, makeApiError, noChangesError } from "@kiwi/contracts/errors";
import { assertCanPatchGraph, selectGraphFields, type GraphRecord } from "../../lib/graph/access";
import type { AuthUser } from "../../middleware/auth";
import { error as logError } from "@kiwi/logger";
import { toApiError } from "../_shared/api-effect";

export function patchGraph(input: { user: AuthUser; graphId: string; body: GraphPatchFields }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                const existingGraph = yield* assertCanPatchGraph(input.user, input.graphId);
                const name = input.body.name?.trim();
                const description = input.body.description === undefined ? undefined : input.body.description || null;
                const hidden =
                    input.body.hidden === undefined
                        ? undefined
                        : input.body.hidden === true || input.body.hidden === "true";

                if (input.body.name !== undefined && !name) {
                    return yield* Effect.fail(makeApiError(400, API_ERROR_CODES.INVALID_NAME, "Invalid name"));
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
                    return yield* Effect.fail(noChangesError());
                }

                return yield* Effect.matchEffect(
                    tryDb((db) =>
                        db
                            .update(graphTable)
                            .set(updateData)
                            .where(eq(graphTable.id, existingGraph.id))
                            .returning(selectGraphFields)
                    ),
                    {
                        onFailure: (dbPatchError) =>
                            Effect.gen(function* () {
                                logError("graph patch failed during database update", {
                                    graphId: existingGraph.id,
                                    error: dbPatchError,
                                });
                                return yield* Effect.fail(internalServerError());
                            }),
                        onSuccess: ([graph]) => Effect.succeed({ graph: graph ?? existingGraph }),
                    }
                );
            }),
            (defect) => Effect.fail(defect)
        ),
        toApiError
    );
}
