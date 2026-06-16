import type { AuthUser } from "../../../middleware/auth";
import { assertCanSyncBinding } from "../../../lib/connector-access";
import { enqueueManualBindingSync, toBindingResponse } from "../../../lib/connector/api";
import { tryApiPromise } from "../../_shared/api-effect";

export function syncConnectorGraphBinding(input: { user: AuthUser; bindingId: string }) {
    return tryApiPromise(async () => {
        const { binding } = await assertCanSyncBinding(input.user, input.bindingId);
        const synced = await enqueueManualBindingSync(binding);
        return {
            binding: toBindingResponse(synced.binding),
            workflowRunId: synced.workflowRunId,
        };
    });
}
