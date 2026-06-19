import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { AuthUser } from "../../../middleware/auth";
import { listConnectorResourceVersionRecords, requireConnectorInstallationContext } from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

export function listConnectorResourceVersions(input: {
    user: AuthUser;
    connectorId: string;
    installationId: string;
    resourceId: string;
}): Effect.Effect<{ name: string; commitSha: string; versionId: string }[], ReturnType<typeof toApiError>, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            const { connector, installation } = yield* requireConnectorInstallationContext(input);
            const versions = yield* listConnectorResourceVersionRecords({
                connector,
                installation,
                resourceId: input.resourceId,
            });
            return versions.map((version) => ({
                name: version.name,
                commitSha: version.versionId,
                versionId: version.versionId,
            }));
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    );
}
