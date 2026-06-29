import * as Effect from "effect/Effect";
import type { Database } from "@kiwi/db/effect";
import type { ConnectorConnectQuery } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES, type ApiError } from "@kiwi/contracts/errors";
import { requireOrganizationAdmin, requireTeamGraphCreateAccess } from "../../../lib/team/access";
import { requireActiveConnector } from "../../../lib/connector-access";
import { signConnectorState } from "../../../lib/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { connectorApiErrorOptions, toApiError } from "../../_shared/api-effect";

type ConnectorInstallStartResult = { redirectUrl: string };
type ConnectorInstallOwnerState = {
    subjectKind: "user" | "team" | "organization";
    subjectUserId?: string;
    subjectTeamId?: string;
    subjectOrganizationId?: string;
    organizationId?: string;
    teamId?: string;
};

export const startConnectorInstall: (input: {
    user: AuthUser;
    connectorId: string;
    query: ConnectorConnectQuery;
}) => Effect.Effect<ConnectorInstallStartResult, ApiError, Database> = Effect.fn("startConnectorInstall")((input) =>
    Effect.mapError(
        Effect.gen(function* () {
            const connector = yield* requireActiveConnector(input.connectorId);
            if (connector.provider !== "github") {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }

            let owner: ConnectorInstallOwnerState;
            const requestedSubjectKind = input.query.subjectKind ?? (input.query.teamId ? "team" : "organization");
            if (requestedSubjectKind === "user") {
                const subjectUserId = input.query.subjectUserId ?? input.user.id;
                if (subjectUserId !== input.user.id) {
                    return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
                }
                owner = { subjectKind: "user", subjectUserId };
            } else if (requestedSubjectKind === "team") {
                const subjectTeamId = input.query.subjectTeamId ?? input.query.teamId;
                if (!subjectTeamId) {
                    return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
                }
                const access = yield* requireTeamGraphCreateAccess(input.user, subjectTeamId);
                owner = {
                    subjectKind: "team",
                    subjectTeamId,
                    organizationId: access.team.organizationId,
                    teamId: subjectTeamId,
                };
            } else {
                const subjectOrganizationId = input.query.subjectOrganizationId ?? input.query.organizationId;
                if (!subjectOrganizationId) {
                    return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
                }
                const membership = yield* requireOrganizationAdmin(input.user, subjectOrganizationId);
                owner = {
                    subjectKind: "organization",
                    subjectOrganizationId: membership.organizationId,
                    organizationId: membership.organizationId,
                };
            }

            const state = signConnectorState({
                purpose: "github-installation",
                userId: input.user.id,
                connectorId: connector.id,
                ...owner,
            });

            if (!connector.appSlug) {
                return yield* Effect.fail(new Error(API_ERROR_CODES.FORBIDDEN));
            }
            return {
                redirectUrl: `https://github.com/apps/${connector.appSlug}/installations/new?state=${encodeURIComponent(state)}`,
            };
        }),
        (error) => toApiError(error, connectorApiErrorOptions)
    )
);
