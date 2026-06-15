import { GitHubConnectorInstallCallbackPage } from "@/components/connectors/ConnectorPages";

export default async function GitHubConnectorInstallCallback({
    searchParams,
}: {
    searchParams: Promise<{
        installation_id?: string | string[];
        setup_action?: string | string[];
        state?: string | string[];
    }>;
}) {
    const params = await searchParams;
    const installationId = typeof params.installation_id === "string" ? params.installation_id : "";
    const setupAction = typeof params.setup_action === "string" ? params.setup_action : "";
    const state = typeof params.state === "string" ? params.state : "";

    return (
        <GitHubConnectorInstallCallbackPage
            installationId={installationId}
            setupAction={setupAction}
            state={state}
        />
    );
}
