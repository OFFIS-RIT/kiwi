import * as Effect from "effect/Effect";
import { NEXTCLOUD_CREDENTIAL_VERSION, NEXTCLOUD_PROVIDER, publicNextcloudResourceId } from "@kiwi/connectors";
import { sql } from "@kiwi/db/drizzle";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorInstallationsTable } from "@kiwi/db/tables/connectors";
import type {
    ConnectorBindingCreateInput,
    NextcloudConnectorInstallationCreateInput,
} from "@kiwi/contracts/connectors";
import { API_ERROR_CODES, type ApiError } from "@kiwi/contracts/errors";
import { requireActiveConnector } from "../../../lib/connector-access";
import { encryptCredentials, toPublicInstallation, type PublicInstallation } from "../../../lib/connectors";
import { requireOrganizationAdmin, requireTeamGraphCreateAccess } from "../../../lib/team/access";
import type { AuthUser } from "../../../middleware/auth";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

type ConnectorOwnerInput = ConnectorBindingCreateInput["owner"];

type ConnectorInstallOwner = {
    subjectKind: "user" | "team" | "organization";
    subjectUserId: string | null;
    subjectTeamId: string | null;
    subjectOrganizationId: string | null;
    organizationId: string | null;
    teamId: string | null;
};

export function createNextcloudConnectorInstallation(input: {
    user: AuthUser;
    connectorId: string;
    body: NextcloudConnectorInstallationCreateInput;
}): Effect.Effect<PublicInstallation, ApiError, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            const connector = yield* requireActiveConnector(input.connectorId, NEXTCLOUD_PROVIDER);
            const owner = yield* resolveInstallOwner(input.user, input.body.owner);
            const folderPath = publicNextcloudResourceId(input.body.folderPath);
            const providerInstallationId = `${input.body.username}:${folderPath}`;
            const [installation] = yield* tryDb((db) =>
                db
                    .insert(connectorInstallationsTable)
                    .values({
                        connectorId: connector.id,
                        provider: NEXTCLOUD_PROVIDER,
                        providerInstallationId,
                        providerAccountLogin: input.body.username,
                        providerAccountType: "user",
                        subjectKind: owner.subjectKind,
                        subjectUserId: owner.subjectUserId,
                        subjectTeamId: owner.subjectTeamId,
                        subjectOrganizationId: owner.subjectOrganizationId,
                        organizationId: owner.organizationId,
                        teamId: owner.teamId,
                        installedByUserId: input.user.id,
                        encryptedCredentials: encryptCredentials({
                            provider: NEXTCLOUD_PROVIDER,
                            subject: "installation",
                            version: NEXTCLOUD_CREDENTIAL_VERSION,
                            data: {
                                username: input.body.username,
                                appPassword: input.body.appPassword,
                                folderPath,
                            },
                        }),
                        repositorySelection: "selected",
                        status: "active",
                    })
                    .onConflictDoUpdate({
                        ...installConflictTarget(owner),
                        set: {
                            providerAccountLogin: input.body.username,
                            providerAccountType: "user",
                            encryptedCredentials: encryptCredentials({
                                provider: NEXTCLOUD_PROVIDER,
                                subject: "installation",
                                version: NEXTCLOUD_CREDENTIAL_VERSION,
                                data: {
                                    username: input.body.username,
                                    appPassword: input.body.appPassword,
                                    folderPath,
                                },
                            }),
                            repositorySelection: "selected",
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

function resolveInstallOwner(
    user: AuthUser,
    owner: ConnectorOwnerInput
): Effect.Effect<ConnectorInstallOwner, Error, Database> {
    return Effect.gen(function* () {
        if (owner.kind === "user") {
            if (owner.userId !== user.id) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }
            return {
                subjectKind: "user",
                subjectUserId: owner.userId,
                subjectTeamId: null,
                subjectOrganizationId: null,
                organizationId: null,
                teamId: null,
            };
        }

        if (owner.kind === "team") {
            const access = yield* requireTeamGraphCreateAccess(user, owner.teamId);
            return {
                subjectKind: "team",
                subjectUserId: null,
                subjectTeamId: owner.teamId,
                subjectOrganizationId: null,
                organizationId: access.team.organizationId,
                teamId: owner.teamId,
            };
        }

        const organizationId = owner.organizationId ?? user.activeOrganizationId;
        if (!organizationId) {
            return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
        }
        const membership = yield* requireOrganizationAdmin(user, organizationId);
        return {
            subjectKind: "organization",
            subjectUserId: null,
            subjectTeamId: null,
            subjectOrganizationId: membership.organizationId,
            organizationId: membership.organizationId,
            teamId: null,
        };
    });
}

function installConflictTarget(owner: ConnectorInstallOwner) {
    if (owner.subjectKind === "user") {
        return {
            target: [
                connectorInstallationsTable.connectorId,
                connectorInstallationsTable.providerInstallationId,
                connectorInstallationsTable.subjectUserId,
            ],
            targetWhere: sql`${connectorInstallationsTable.subjectKind} = 'user'`,
        };
    }

    if (owner.subjectKind === "team") {
        return {
            target: [
                connectorInstallationsTable.connectorId,
                connectorInstallationsTable.providerInstallationId,
                connectorInstallationsTable.subjectTeamId,
            ],
            targetWhere: sql`${connectorInstallationsTable.subjectKind} = 'team'`,
        };
    }

    return {
        target: [
            connectorInstallationsTable.connectorId,
            connectorInstallationsTable.providerInstallationId,
            connectorInstallationsTable.subjectOrganizationId,
        ],
        targetWhere: sql`${connectorInstallationsTable.subjectKind} = 'organization'`,
    };
}
