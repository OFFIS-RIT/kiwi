import type { AuthUser } from "../../../middleware/auth";
import { assertCanViewBinding } from "../../../lib/connector-access";
import { toBindingResponse } from "../../../lib/connector/api";
import { tryApiPromise } from "../../_shared/api-effect";

export function getConnectorGraphBinding(input: { user: AuthUser; bindingId: string }) {
    return tryApiPromise(async () => {
        const { binding } = await assertCanViewBinding(input.user, input.bindingId);
        return toBindingResponse(binding);
    });
}
