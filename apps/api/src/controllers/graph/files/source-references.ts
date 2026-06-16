import type { SourceReferenceBatchSuccessData } from "@kiwi/contracts";
import { assertCanViewGraph } from "../../../lib/graph/access";
import { loadSourceReferences } from "../../../lib/source-reference";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function listSourceReferences(input: { user: AuthUser; graphId: string; sourceIds: string[] }) {
    return tryApiPromise(async (): Promise<SourceReferenceBatchSuccessData> => {
        await assertCanViewGraph(input.user, input.graphId);
        return loadSourceReferences(input.graphId, input.sourceIds);
    });
}
