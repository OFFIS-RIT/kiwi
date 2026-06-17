import * as Effect from "effect/Effect";
import type { AuthUser } from "../../../middleware/auth";
import { listConnectorResourceRecords, requireConnectorInstallationContext } from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect"

export function listConnectorResources(input: { user: AuthUser; connectorId: string; installationId: string }) {
    return Effect.mapError(Effect.gen(function* () {
        const { connector, installation } = yield* requireConnectorInstallationContext(input);
        const resources = yield* listConnectorResourceRecords(connector, installation);
        return resources.map((resource) => ({
            ...resource.git,
            resourceKind: resource.kind,
            displayName: resource.displayName,
            webUrl: resource.webUrl,
            defaultVersionName: resource.defaultVersion ?? undefined,
        }));
    }), (error) => toApiError(error, connectorApiErrorOptions));
}
