import { hasRole } from "@kiwi/auth/permissions";
import { forbidden } from "next/navigation";

import { GitHubConnectorNewPage } from "@/components/connectors/ConnectorPages";
import { getServerSession } from "@/lib/auth/get-server-session";

export default async function NewGitHubConnectorPage() {
    const session = await getServerSession();
    if (!hasRole((session?.user as { role?: string })?.role ?? null, "admin")) {
        forbidden();
    }

    return <GitHubConnectorNewPage />;
}
