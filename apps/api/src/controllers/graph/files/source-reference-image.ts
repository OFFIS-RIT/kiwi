import * as Effect from "effect/Effect";
import { API_ERROR_CODES, makeApiError } from "@kiwi/contracts/errors";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadSourceReferenceImage, type SourceReferenceImage } from "../../../lib/source-reference";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function getSourceReferenceImage(input: { user: AuthUser; graphId: string; sourceId: string; chunkId: string }) {
    return tryApiPromise(async (): Promise<SourceReferenceImage> => {
        const chunkId = Number(input.chunkId);
        if (!Number.isInteger(chunkId) || chunkId < 1) {
            throw makeApiError(404, API_ERROR_CODES.SOURCE_NOT_FOUND, "Source not found");
        }

        await Effect.runPromise(assertCanViewGraph(input.user, input.graphId));
        return Effect.runPromise(loadSourceReferenceImage(input.graphId, input.sourceId, chunkId));
    });
}
