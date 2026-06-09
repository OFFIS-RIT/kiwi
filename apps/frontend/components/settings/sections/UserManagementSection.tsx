"use client";

import { CreateUserDialog } from "@/components/admin/CreateUserDialog";
import { UserTable } from "@/components/admin/UserTable";
import { Button } from "@/components/ui/button";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { UserPlus } from "lucide-react";
import { useState } from "react";

export function UserManagementSection() {
    const t = useAppTranslations();
    const { authMode } = useRuntimeConfig();
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    return (
        <section className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold">{t("admin.user.management")}</h1>
                    <p className="text-sm text-muted-foreground">{t("admin.users")}</p>
                </div>
                {authMode === "credentials" ? (
                    <Button variant="outline" size="sm" onClick={() => setShowCreateUser(true)}>
                        <UserPlus className="mr-2 h-4 w-4" />
                        {t("admin.create.user")}
                    </Button>
                ) : null}
            </div>
            <UserTable key={refreshKey} />
            <CreateUserDialog
                open={showCreateUser}
                onOpenChange={setShowCreateUser}
                onCreated={() => setRefreshKey((key) => key + 1)}
            />
        </section>
    );
}
