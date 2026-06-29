import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { ApiError } from "@kiwi/contracts/errors";
import type { ConnectorResourceRecord } from "@kiwi/contracts/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { listConnectorResourceRecords, requireConnectorInstallationContext } from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

export type ConnectorResourceListResult = ConnectorResourceRecord[];

export const listConnectorResources: (input: {
    user: AuthUser;
    connectorId: string;
    installationId: string;
}) => Effect.Effect<ConnectorResourceListResult, ApiError, Database> = Effect.fn("listConnectorResources")((input) =>
    Effect.mapError(
        Effect.gen(function* () {
            const { connector, installation } = yield* requireConnectorInstallationContext(input);
            const resources = yield* listConnectorResourceRecords(connector, installation);
            return resources.map((resource) => ({
                ...resource.git,
                provider: resource.provider,
                resourceKind: resource.kind,
                resourceId: resource.id,
                providerResourceId: resource.id,
                resourceDisplayName: resource.displayName,
                resourceWebUrl: resource.webUrl,
                defaultVersionName: resource.defaultVersionName ?? undefined,
                defaultVersionId: resource.defaultVersionId,
                metadata: undefined,
                id: resource.id,
                displayName: resource.displayName,
                webUrl: resource.webUrl,
            }));
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    )
);
