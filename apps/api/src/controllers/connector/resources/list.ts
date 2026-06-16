import type { AuthUser } from "../../../middleware/auth";
import { listConnectorResourceRecords, requireConnectorInstallationContext } from "../../../lib/connector/api";
import { tryApiPromise } from "../../_shared/api-effect";

export function listConnectorResources(input: { user: AuthUser; connectorId: string; installationId: string }) {
    return tryApiPromise(async () => {
        const { connector, installation } = await requireConnectorInstallationContext(input);
        const resources = await listConnectorResourceRecords(connector, installation);
        return resources.map((resource) => ({
            ...resource.git,
            resourceKind: resource.kind,
            displayName: resource.displayName,
            webUrl: resource.webUrl,
            defaultVersionName: resource.defaultVersion ?? undefined,
        }));
    });
}
