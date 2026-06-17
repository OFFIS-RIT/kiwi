import * as Effect from "effect/Effect";
import type { AuthUser } from "../../../middleware/auth";
import { assertCanViewBinding } from "../../../lib/connector-access";
import { toBindingResponse } from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect"

export function getConnectorGraphBinding(input: { user: AuthUser; bindingId: string }) {
    return Effect.mapError(Effect.map(assertCanViewBinding(input.user, input.bindingId), ({ binding }) => toBindingResponse(binding)), (error) => toApiError(error, connectorApiErrorOptions));
}
