import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorInstallationsTable } from "@kiwi/db/tables/connectors";
import type { GitHubInstallCallbackQuery } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { sql } from "drizzle-orm";
import { requireOrganizationAdmin, requireTeamGraphCreateAccess } from "../../../lib/team/access";
import { requireActiveConnector } from "../../../lib/connector-access";
import {
    getGitHubConnectorInstallationAccount,
    toPublicInstallation,
    verifyConnectorState,
} from "../../../lib/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

export function completeGitHubConnectorInstall(input: {
    user: AuthUser;
    query: GitHubInstallCallbackQuery;
}): Effect.Effect<ReturnType<typeof toPublicInstallation>, ReturnType<typeof toApiError>, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            const state = verifyConnectorState(input.query.state, "github-installation", input.user.id);
            if (!state?.connectorId) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }

            const connector = yield* requireActiveConnector(state.connectorId!, "github");
            let ownerOrganizationId: string;
            let ownerTeamId: string | null = null;
            if (state.teamId) {
                const access = yield* requireTeamGraphCreateAccess(input.user, state.teamId);
                ownerOrganizationId = access.team.organizationId;
                ownerTeamId = state.teamId;
                if (state.organizationId && state.organizationId !== ownerOrganizationId) {
                    return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
                }
            } else {
                const membership = yield* requireOrganizationAdmin(input.user, state.organizationId);
                ownerOrganizationId = membership.organizationId;
            }

            const conflictTarget = ownerTeamId
                ? {
                      target: [
                          connectorInstallationsTable.connectorId,
                          connectorInstallationsTable.providerInstallationId,
                          connectorInstallationsTable.organizationId,
                          connectorInstallationsTable.teamId,
                      ],
                      targetWhere: sql`${connectorInstallationsTable.teamId} is not null`,
                  }
                : {
                      target: [
                          connectorInstallationsTable.connectorId,
                          connectorInstallationsTable.providerInstallationId,
                          connectorInstallationsTable.organizationId,
                      ],
                      targetWhere: sql`${connectorInstallationsTable.teamId} is null`,
                  };

            const account = yield* getGitHubConnectorInstallationAccount(connector, input.query.installation_id);
            const [installation] = yield* tryDb((db) =>
                db
                    .insert(connectorInstallationsTable)
                    .values({
                        connectorId: connector.id,
                        provider: "github",
                        providerInstallationId: input.query.installation_id,
                        providerAccountLogin: account.login,
                        providerAccountType: account.type,
                        organizationId: ownerOrganizationId,
                        teamId: ownerTeamId,
                        installedByUserId: input.user.id,
                        repositorySelection: account.repositorySelection,
                    })
                    .onConflictDoUpdate({
                        ...conflictTarget,
                        set: {
                            providerAccountLogin: account.login,
                            providerAccountType: account.type,
                            repositorySelection: account.repositorySelection,
                            status: "active",
                            installedByUserId: input.user.id,
                        },
                    })
                    .returning()
            );

            return toPublicInstallation(installation);
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    );
}
