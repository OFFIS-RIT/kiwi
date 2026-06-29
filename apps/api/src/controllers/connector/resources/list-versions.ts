import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { ApiError } from "@kiwi/contracts/errors";
import type { ConnectorResourceVersionRecord } from "@kiwi/contracts/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { listConnectorResourceVersionRecords, requireConnectorInstallationContext } from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

export type ConnectorResourceVersionListResult = ConnectorResourceVersionRecord[];

export const listConnectorResourceVersions: (input: {
    user: AuthUser;
    connectorId: string;
    installationId: string;
    resourceId: string;
}) => Effect.Effect<ConnectorResourceVersionListResult, ApiError, Database> = Effect.fn(
    "listConnectorResourceVersions"
)((input) =>
    Effect.mapError(
        Effect.gen(function* () {
            const { connector, installation } = yield* requireConnectorInstallationContext(input);
            const versions = yield* listConnectorResourceVersionRecords({
                connector,
                installation,
                resourceId: input.resourceId,
            });
            return versions.map((version) => ({
                versionName: version.name,
                versionId: version.versionId,
                resourceId: version.resourceId,
                name: version.name,
                commitSha: version.versionId,
            }));
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    )
);
