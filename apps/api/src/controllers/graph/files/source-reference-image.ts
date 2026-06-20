import * as Effect from "effect/Effect";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadSourceReferenceImage } from "../../../lib/source-reference";
import type { AuthUser } from "../../../middleware/auth";
import { toApiError } from "../../_shared/api-effect";

export function getSourceReferenceImage(input: { user: AuthUser; graphId: string; sourceId: string; chunkId: string }) {
    return Effect.mapError(
        Effect.catchDefect(
            Effect.gen(function* () {
                const chunkId = Number(input.chunkId);
                if (!Number.isInteger(chunkId) || chunkId < 1) {
                    return yield* Effect.fail(makeApiError(404, API_ERROR_CODES.SOURCE_NOT_FOUND, "Source not found"));
                }

                yield* assertCanViewGraph(input.user, input.graphId);
                return yield* loadSourceReferenceImage(input.graphId, input.sourceId, chunkId);
            }),
            (defect) => Effect.fail(defect)
        ),
        toApiError
    );
}
