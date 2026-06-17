import * as Effect from "effect/Effect";
import type { SourceReferenceBatchSuccessData } from "@kiwi/contracts";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadSourceReferences } from "../../../lib/source-reference";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function listSourceReferences(input: { user: AuthUser; graphId: string; sourceIds: string[] }) {
    return tryApiPromise(async (): Promise<SourceReferenceBatchSuccessData> => {
        await Effect.runPromise(assertCanViewGraph(input.user, input.graphId));
        return Effect.runPromise(loadSourceReferences(input.graphId, input.sourceIds));
    });
}
