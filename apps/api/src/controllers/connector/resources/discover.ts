import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { ConnectorDiscoveryItemRecord } from "@kiwi/contracts/connectors";
import type { ApiError } from "@kiwi/contracts/errors";
import type { AuthUser } from "../../../middleware/auth";
import { listConnectorDiscoveryRecords, requireConnectorInstallationContext } from "../../../lib/connector/api";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

export type ConnectorDiscoverResult = ConnectorDiscoveryItemRecord[];

export const discoverConnectorResources: (input: {
    user: AuthUser;
    connectorId: string;
    installationId: string;
    parentId?: string;
}) => Effect.Effect<ConnectorDiscoverResult, ApiError, Database> = Effect.fn("discoverConnectorResources")((input) =>
    Effect.mapError(
        Effect.gen(function* () {
            const { connector, installation } = yield* requireConnectorInstallationContext(input);
            return yield* listConnectorDiscoveryRecords({
                connector,
                installation,
                parentId: input.parentId,
            });
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    )
);
