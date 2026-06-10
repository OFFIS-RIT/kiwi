import { hasRole } from "@kiwi/auth/permissions";
import { forbidden } from "next/navigation";

import { SettingsContent } from "@/components/settings/SettingsContent";
import { getAdminOnlySectionIds } from "@/components/settings/sections";
import { getServerSession } from "@/lib/auth/get-server-session";

// Derived from the registry's visibility predicates so the guard can't drift
// when new admin-only Sections are added.
const ADMIN_ONLY_SECTION_IDS = new Set(getAdminOnlySectionIds());

export default async function SettingsPage({
    searchParams,
}: {
    searchParams: Promise<{ section?: string | string[] }>;
}) {
    const { section } = await searchParams;
    // Normalise to the first value, mirroring the client's URLSearchParams.get(),
    // so a repeated param (?section=user-management&section=x) can't slip an array
    // past the comparison below and bypass the guard.
    const activeSection = Array.isArray(section) ? section[0] : section;

    // Server-side defence-in-depth for admin-only Sections: the client also hides
    // these for non-admins, and the admin APIs enforce the role themselves, but we
    // still refuse to render the admin surface server-side.
    if (activeSection && ADMIN_ONLY_SECTION_IDS.has(activeSection)) {
        const session = await getServerSession();
        if (!hasRole((session?.user as { role?: string })?.role ?? null, "admin")) {
            forbidden();
        }
    }

    return <SettingsContent />;
}
