"use client";

import { UserTable } from "@/components/admin/UserTable";
import { DashboardFrame } from "@/components/common/DashboardFrame";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";
import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { UserPlus } from "lucide-react";
import { useState } from "react";
import { CreateUserDialog } from "./CreateUserDialog";

export function AdminView() {
    const t = useTranslations();
    const { authMode } = useRuntimeConfig();
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    return (
        <DashboardFrame>
            <div className="h-full overflow-y-auto">
                <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h1 className="text-2xl font-bold">{t("admin.user.management")}</h1>
                            <p className="text-muted-foreground">{t("admin.users")}</p>
                        </div>
                        {authMode === "credentials" ? (
                            <Button variant="outline" size="sm" onClick={() => setShowCreateUser(true)}>
                                <UserPlus className="mr-2 h-4 w-4" />
                                {t("admin.create.user")}
                            </Button>
                        ) : null}
                    </div>
                    <UserTable key={refreshKey} />
                </div>
            </div>
            <CreateUserDialog
                open={showCreateUser}
                onOpenChange={setShowCreateUser}
                onCreated={() => setRefreshKey((key) => key + 1)}
            />
        </DashboardFrame>
    );
}
