import type { ReactNode } from "react";

import { fetchSession } from "@/lib/api/server";
import { redirect } from "next/navigation";

export default async function AuthLayout({ children }: { children: ReactNode }) {
    const session = await fetchSession();
    if (session) redirect("/");

    return <>{children}</>;
}
