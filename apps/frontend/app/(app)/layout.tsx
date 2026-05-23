import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { DashboardFrame } from "@/components/common/DashboardFrame";
import { AppShell } from "@/components/common/AppShell";
import { getServerSession } from "@/lib/auth/get-server-session";
import type { InitialClientSession } from "@/lib/auth/types";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
    const session = await getServerSession();
    if (!session) {
        const headersList = await headers();
        const url = headersList.get("x-pathname") ?? "";
        const next = url ? `?next=${encodeURIComponent(url)}` : "";
        redirect(`/login${next}`);
    }

    const initialSession: InitialClientSession = {
        user: {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
            image: session.user.image ?? null,
            role: (session.user as { role?: string }).role ?? null,
        },
    };

    return (
        <AppShell initialSession={initialSession}>
            <DashboardFrame>{children}</DashboardFrame>
        </AppShell>
    );
}
