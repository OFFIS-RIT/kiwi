import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { ApiError } from "@kiwi/contracts/errors";
import type { AuthUser } from "../../../middleware/auth";
import { assertCanSyncBinding } from "../../../lib/connector-access";
import { enqueueManualBindingSync, toBindingResponse, type ConnectorBindingResponse } from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

export type ConnectorGraphBindingSyncResult = { binding: ConnectorBindingResponse; workflowRunId: string };

export const syncConnectorGraphBinding: (input: {
    user: AuthUser;
    bindingId: string;
}) => Effect.Effect<ConnectorGraphBindingSyncResult, ApiError, Database> = Effect.fn("syncConnectorGraphBinding")(
    (input: { user: AuthUser; bindingId: string }) =>
        Effect.mapError(
            Effect.gen(function* () {
                const { binding } = yield* assertCanSyncBinding(input.user, input.bindingId);
                const synced = yield* enqueueManualBindingSync(binding);
                return {
                    binding: toBindingResponse(synced.binding),
                    workflowRunId: synced.workflowRunId,
                };
            }),
            (error) => toApiError(error, connectorApiErrorOptions)
        )
);
