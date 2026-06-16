import type { ConnectorConnectQuery } from "@kiwi/contracts/connectors";
import { API_ERROR_CODES } from "@kiwi/contracts/errors";
import { assertCanCreateTeamGraph } from "../../../lib/graph/access";
import { requireOrganizationAdmin } from "../../../lib/team/access";
import { requireActiveConnector } from "../../../lib/connector-access";
import { signConnectorState } from "../../../lib/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { tryApiPromise } from "../../_shared/api-effect";

export function startConnectorInstall(input: { user: AuthUser; connectorId: string; query: ConnectorConnectQuery }) {
    return tryApiPromise(async () => {
        const connector = await requireActiveConnector(input.connectorId);
        let owner: { organizationId: string; teamId?: string };
        if (input.query.teamId) {
            const access = await assertCanCreateTeamGraph(input.user, input.query.teamId);
            owner = { organizationId: access.team.organizationId, teamId: input.query.teamId };
        } else {
            const membership = await requireOrganizationAdmin(input.user, input.query.organizationId);
            owner = { organizationId: membership.organizationId };
        }
    
        const state = signConnectorState({
            purpose: connector.provider === "github" ? "github-installation" : "gitlab-oauth",
            userId: input.user.id,
            connectorId: connector.id,
            organizationId: owner.organizationId,
            ...(owner.teamId ? { teamId: owner.teamId } : {}),
        });
    
        if (connector.provider === "github") {
            if (!connector.appSlug) {
                throw new Error(API_ERROR_CODES.FORBIDDEN);
            }
            return {
                redirectUrl: `https://github.com/apps/${connector.appSlug}/installations/new?state=${encodeURIComponent(state)}`,
            };
        }
    
        throw new Error("GitLab connector installations are disabled until OAuth flow support lands.");
    });
}
