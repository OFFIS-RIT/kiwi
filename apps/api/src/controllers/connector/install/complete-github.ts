import * as Effect from "effect/Effect";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorInstallationsTable } from "@kiwi/db/tables/connectors";
import type { GitHubInstallCallbackQuery } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES, type ApiError } from "@kiwi/contracts/errors";
import { sql } from "@kiwi/db/drizzle";
import { requireOrganizationAdmin, requireTeamGraphCreateAccess } from "../../../lib/team/access";
import { requireActiveConnector } from "../../../lib/connector-access";
import {
    getGitHubConnectorInstallationAccount,
    toPublicInstallation,
    verifyConnectorState,
    type PublicInstallation,
} from "../../../lib/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

type ConnectorInstallOwner = {
    subjectKind: "user" | "team" | "organization";
    subjectUserId: string | null;
    subjectTeamId: string | null;
    subjectOrganizationId: string | null;
    organizationId: string | null;
    teamId: string | null;
};

export const completeGitHubConnectorInstall: (input: {
    user: AuthUser;
    query: GitHubInstallCallbackQuery;
}) => Effect.Effect<PublicInstallation, ApiError, Database> = Effect.fn("completeGitHubConnectorInstall")((input) =>
    Effect.mapError(
        Effect.gen(function* () {
            const state = verifyConnectorState(input.query.state, "github-installation", input.user.id);
            if (!state?.connectorId) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }

            const connector = yield* requireActiveConnector(state.connectorId, "github");
            let owner: ConnectorInstallOwner;
            const subjectKind = state.subjectKind ?? (state.teamId ? "team" : "organization");
            if (subjectKind === "user") {
                const subjectUserId = state.subjectUserId ?? input.user.id;
                if (subjectUserId !== input.user.id) {
                    return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
                }
                owner = {
                    subjectKind: "user",
                    subjectUserId,
                    subjectTeamId: null,
                    subjectOrganizationId: null,
                    organizationId: null,
                    teamId: null,
                };
            } else if (subjectKind === "team") {
                const subjectTeamId = state.subjectTeamId ?? state.teamId;
                if (!subjectTeamId) {
                    return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
                }
                const access = yield* requireTeamGraphCreateAccess(input.user, subjectTeamId);
                if (state.organizationId && state.organizationId !== access.team.organizationId) {
                    return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
                }
                owner = {
                    subjectKind: "team",
                    subjectUserId: null,
                    subjectTeamId,
                    subjectOrganizationId: null,
                    organizationId: access.team.organizationId,
                    teamId: subjectTeamId,
                };
            } else {
                const subjectOrganizationId = state.subjectOrganizationId ?? state.organizationId;
                if (!subjectOrganizationId) {
                    return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
                }
                const membership = yield* requireOrganizationAdmin(input.user, subjectOrganizationId);
                owner = {
                    subjectKind: "organization",
                    subjectUserId: null,
                    subjectTeamId: null,
                    subjectOrganizationId: membership.organizationId,
                    organizationId: membership.organizationId,
                    teamId: null,
                };
            }

            const conflictTarget =
                owner.subjectKind === "user"
                    ? {
                          target: [
                              connectorInstallationsTable.connectorId,
                              connectorInstallationsTable.providerInstallationId,
                              connectorInstallationsTable.subjectUserId,
                          ],
                          targetWhere: sql`${connectorInstallationsTable.subjectKind} = 'user'`,
                      }
                    : owner.subjectKind === "team"
                      ? {
                            target: [
                                connectorInstallationsTable.connectorId,
                                connectorInstallationsTable.providerInstallationId,
                                connectorInstallationsTable.subjectTeamId,
                            ],
                            targetWhere: sql`${connectorInstallationsTable.subjectKind} = 'team'`,
                        }
                      : {
                            target: [
                                connectorInstallationsTable.connectorId,
                                connectorInstallationsTable.providerInstallationId,
                                connectorInstallationsTable.subjectOrganizationId,
                            ],
                            targetWhere: sql`${connectorInstallationsTable.subjectKind} = 'organization'`,
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
                        subjectKind: owner.subjectKind,
                        subjectUserId: owner.subjectUserId,
                        subjectTeamId: owner.subjectTeamId,
                        subjectOrganizationId: owner.subjectOrganizationId,
                        organizationId: owner.organizationId,
                        teamId: owner.teamId,
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
    )
);
