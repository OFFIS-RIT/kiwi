import type { ReactNode } from "react";

import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { fetchGroupsWithProjects, fetchSession } from "@/lib/api/server";
import { DashboardProviders } from "@/providers/DashboardProviders";
import { redirect } from "next/navigation";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
    const session = await fetchSession();
    if (!session) redirect("/login");

    const authMode = process.env.AUTH_MODE ?? "credentials";
    const buildLabel = process.env.APP_BUILD_LABEL?.trim() ?? "";
    const groups = await fetchGroupsWithProjects();

    return (
        <DashboardProviders session={session} authMode={authMode} initialGroups={groups}>
            <AppSidebar buildLabel={buildLabel} />
            {children}
        </DashboardProviders>
    );
}
