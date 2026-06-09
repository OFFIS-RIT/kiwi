import { hasRole } from "@kiwi/auth/permissions";
import { forbidden } from "next/navigation";

import { SettingsContent } from "@/components/settings/SettingsContent";
import { getServerSession } from "@/lib/auth/get-server-session";

export default async function SettingsPage({
    searchParams,
}: {
    searchParams: Promise<{ section?: string | string[] }>;
}) {
    const { section } = await searchParams;

    // Server-side defence-in-depth for admin-only Sections: the client also hides
    // these for non-admins, and the admin APIs enforce the role themselves, but we
    // still refuse to render the admin surface server-side.
    if (section === "user-management") {
        const session = await getServerSession();
        if (!hasRole((session?.user as { role?: string })?.role ?? null, "admin")) {
            forbidden();
        }
    }

    return <SettingsContent />;
}
