import * as Effect from "effect/Effect";
import { SHAREPOINT_CREDENTIAL_VERSION, SHAREPOINT_PROVIDER, publicSharePointResourceId } from "@kiwi/connectors";
import { sql } from "@kiwi/db/drizzle";
import { tryDb, type Database } from "@kiwi/db/effect";
import { connectorInstallationsTable } from "@kiwi/db/tables/connectors";
import type {
    ConnectorBindingCreateInput,
    SharePointConnectorInstallationCreateInput,
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

export function createSharePointConnectorInstallation(input: {
    user: AuthUser;
    connectorId: string;
    body: SharePointConnectorInstallationCreateInput;
}): Effect.Effect<PublicInstallation, ApiError, Database> {
    return Effect.mapError(
        Effect.gen(function* () {
            const connector = yield* requireActiveConnector(input.connectorId, SHAREPOINT_PROVIDER);
            const owner = yield* resolveInstallOwner(input.user, input.body.owner);
            const folderPath = publicSharePointResourceId(input.body.folderPath);
            const folderId = normalizeOptionalString(input.body.folderId);
            const providerInstallationId = `${input.body.siteId}:${input.body.driveId}:${folderId ?? folderPath}`;
            const installationCredentials = {
                provider: SHAREPOINT_PROVIDER,
                subject: "installation" as const,
                version: SHAREPOINT_CREDENTIAL_VERSION,
                data: {
                    siteId: input.body.siteId,
                    driveId: input.body.driveId,
                    folderPath,
                    ...(folderId ? { folderId } : {}),
                },
            };
            const [installation] = yield* tryDb((db) =>
                db
                    .insert(connectorInstallationsTable)
                    .values({
                        connectorId: connector.id,
                        provider: SHAREPOINT_PROVIDER,
                        providerInstallationId,
                        providerAccountLogin: input.body.siteId,
                        providerAccountType: "organization",
                        subjectKind: owner.subjectKind,
                        subjectUserId: owner.subjectUserId,
                        subjectTeamId: owner.subjectTeamId,
                        subjectOrganizationId: owner.subjectOrganizationId,
                        organizationId: owner.organizationId,
                        teamId: owner.teamId,
                        installedByUserId: input.user.id,
                        encryptedCredentials: encryptCredentials(installationCredentials),
                        repositorySelection: "selected",
                        status: "active",
                    })
                    .onConflictDoUpdate({
                        ...installConflictTarget(owner),
                        set: {
                            providerAccountLogin: input.body.siteId,
                            providerAccountType: "organization",
                            encryptedCredentials: encryptCredentials(installationCredentials),
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

function normalizeOptionalString(value: string | undefined): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
