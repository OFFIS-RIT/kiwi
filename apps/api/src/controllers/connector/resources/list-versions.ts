import type { AuthUser } from "../../../middleware/auth";
import { listConnectorResourceVersionRecords, requireConnectorInstallationContext } from "../../../lib/connector/api";
import { tryApiPromise } from "../../_shared/api-effect";

export function listConnectorResourceVersions(input: {
    user: AuthUser;
    connectorId: string;
    installationId: string;
    resourceId: string;
}) {
    return tryApiPromise(async () => {
        const { connector, installation } = await requireConnectorInstallationContext(input);
        const versions = await listConnectorResourceVersionRecords({
            connector,
            installation,
            resourceId: input.resourceId,
        });
        return versions.map((version) => ({ name: version.name, commitSha: version.versionId, versionId: version.versionId }));
    });
}
