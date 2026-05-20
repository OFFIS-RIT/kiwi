import { hasRole } from "@kiwi/auth/permissions";
import { forbidden } from "next/navigation";
import type { ReactNode } from "react";

import { getServerSession } from "@/lib/auth/get-server-session";

export default async function AdminLayout({ children }: { children: ReactNode }) {
    const session = await getServerSession();
    if (!hasRole((session?.user as { role?: string })?.role ?? null, "admin")) {
        forbidden();
    }

    return <>{children}</>;
}
