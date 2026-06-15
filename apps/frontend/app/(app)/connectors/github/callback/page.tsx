import { GitHubConnectorCallbackPage } from "@/components/connectors/ConnectorPages";

export default async function GitHubConnectorCallback({
    searchParams,
}: {
    searchParams: Promise<{ code?: string | string[]; state?: string | string[] }>;
}) {
    const params = await searchParams;
    const code = typeof params.code === "string" ? params.code : "";
    const state = typeof params.state === "string" ? params.state : "";

    return <GitHubConnectorCallbackPage code={code} state={state} />;
}
