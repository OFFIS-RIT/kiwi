import { hasRole } from "@kiwi/auth/permissions";
import { forbidden } from "next/navigation";

import { GitLabConnectorNewPage } from "@/components/connectors/ConnectorPages";
import { getServerSession } from "@/lib/auth/get-server-session";

export default async function NewGitLabConnectorPage() {
    const session = await getServerSession();
    if (!hasRole((session?.user as { role?: string })?.role ?? null, "admin")) {
        forbidden();
    }

    return <GitLabConnectorNewPage />;
}
