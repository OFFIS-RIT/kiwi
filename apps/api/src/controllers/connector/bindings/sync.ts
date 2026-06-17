import * as Effect from "effect/Effect";
import type { AuthUser } from "../../../middleware/auth";
import { assertCanSyncBinding } from "../../../lib/connector-access";
import { enqueueManualBindingSync, toBindingResponse } from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect"

export function syncConnectorGraphBinding(input: { user: AuthUser; bindingId: string }) {
    return Effect.mapError(Effect.gen(function* () {
        const { binding } = yield* assertCanSyncBinding(input.user, input.bindingId);
        const synced = yield* enqueueManualBindingSync(binding);
        return {
            binding: toBindingResponse(synced.binding),
            workflowRunId: synced.workflowRunId,
        };
    }), (error) => toApiError(error, connectorApiErrorOptions));
}
