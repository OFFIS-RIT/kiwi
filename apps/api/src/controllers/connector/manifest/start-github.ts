import type { GitHubConnectorManifestStartInput } from "@kiwi/contracts/connectors";
import type { AuthUser } from "../../../middleware/auth";
import { createManifestUrl, signConnectorState } from "../../../lib/connectors";
import { assertSystemAdmin } from "../../../lib/connector/api";
import { tryApiPromise } from "../../_shared/api-effect";

export function startGitHubConnectorManifest(input: { user: AuthUser; body: GitHubConnectorManifestStartInput }) {
    return tryApiPromise(async () => {
        assertSystemAdmin(input.user);
        const state = signConnectorState({ purpose: "github-manifest", userId: input.user.id });
        return { state, manifestUrl: createManifestUrl(state, input.body.name.trim()) };
    });
}
