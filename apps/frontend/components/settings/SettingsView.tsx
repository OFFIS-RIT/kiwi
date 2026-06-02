"use client";

import { ApiKeyList } from "@/components/api-keys/ApiKeyList";
import { ApiKeyRevealDialog } from "@/components/api-keys/ApiKeyRevealDialog";
import { CreateApiKeyDialog } from "@/components/api-keys/CreateApiKeyDialog";
import { CreateUserDialog } from "@/components/admin/CreateUserDialog";
import { UserTable } from "@/components/admin/UserTable";
import { ArchivedChatList } from "./ArchivedChatList";
import { SettingsGroupManagement } from "./SettingsGroupManagement";
import { SettingsLanguageSelect } from "./SettingsLanguageSelect";
import { SettingsProfile } from "./SettingsProfile";
import { getSettingsSection } from "./SettingsSidebar";
import { ThemeToggle } from "@/components/header/ThemeToggle";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { canAccessSystemAdmin } from "@/lib/capabilities";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useAuth } from "@/providers/AuthProvider";
import { useRuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { Plus, UserPlus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

export function SettingsView() {
    const t = useAppTranslations();
    const { authMode } = useRuntimeConfig();
    const { isSystemAdmin } = useAuth();
    const canOpenAdmin = canAccessSystemAdmin({ isSystemAdmin });
    const searchParams = useSearchParams();
    const requestedSection = getSettingsSection(searchParams.get("section"));
    const section =
        (requestedSection === "admin" || requestedSection === "group-management") && !canOpenAdmin
            ? "appearance"
            : requestedSection;
    const [showCreate, setShowCreate] = useState(false);
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [showCreateUser, setShowCreateUser] = useState(false);
    const [userRefreshKey, setUserRefreshKey] = useState(0);
    const currentTitle =
        section === "appearance"
            ? t("appearance")
            : section === "profile"
              ? t("settings.profile.title")
            : section === "mcp-keys"
              ? t("settings.mcpKeys.title")
              : section === "admin"
                ? t("admin.user.management")
                : section === "group-management"
                  ? t("settings.groupManagement.title")
                : t("settings.archived.title");

    return (
        <>
            <div className="flex h-full flex-col overflow-hidden">
                <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4 md:hidden">
                    <SidebarTrigger className="-ml-1" />
                    <span className="text-sm font-medium">{currentTitle}</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
                    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
                        {section === "appearance" ? (
                            <section className="space-y-6">
                                <div>
                                    <h1 className="text-2xl font-semibold">{t("appearance")}</h1>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        {t("settings.appearance.description")}
                                    </p>
                                </div>
                                <div className="overflow-hidden rounded-lg border">
                                    <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
                                        <div>
                                            <h2 className="text-sm font-medium">{t("theme")}</h2>
                                            <p className="text-sm text-muted-foreground">
                                                {t("settings.theme.description")}
                                            </p>
                                        </div>
                                        <ThemeToggle asMenuItem={false} showLabel={false} />
                                    </div>
                                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                                        <div>
                                            <h2 className="text-sm font-medium">{t("language")}</h2>
                                            <p className="text-sm text-muted-foreground">
                                                {t("settings.language.description")}
                                            </p>
                                        </div>
                                        <SettingsLanguageSelect />
                                    </div>
                                </div>
                            </section>
                        ) : null}
                        {section === "profile" ? (
                            <section className="space-y-6">
                                <div>
                                    <h1 className="text-2xl font-semibold">{t("settings.profile.title")}</h1>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        {t("settings.profile.description")}
                                    </p>
                                </div>
                                <SettingsProfile />
                            </section>
                        ) : null}
                        {section === "mcp-keys" ? (
                            <section className="space-y-6">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <h1 className="text-2xl font-semibold">{t("settings.mcpKeys.title")}</h1>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                            {t("settings.mcpKeys.description")}
                                        </p>
                                    </div>
                                    <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
                                        <Plus className="mr-2 h-4 w-4" />
                                        {t("apiKey.create")}
                                    </Button>
                                </div>
                                <div className="rounded-lg border p-2">
                                    <ApiKeyList key={refreshKey} />
                                </div>
                            </section>
                        ) : null}
                        {section === "admin" ? (
                            <section className="space-y-6">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <h1 className="text-2xl font-semibold">{t("admin.user.management")}</h1>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                            {t("settings.admin.description")}
                                        </p>
                                    </div>
                                    {authMode === "credentials" ? (
                                        <Button variant="outline" size="sm" onClick={() => setShowCreateUser(true)}>
                                            <UserPlus className="mr-2 h-4 w-4" />
                                            {t("admin.create.user")}
                                        </Button>
                                    ) : null}
                                </div>
                                <div className="rounded-lg border p-2">
                                    <UserTable key={userRefreshKey} />
                                </div>
                            </section>
                        ) : null}
                        {section === "group-management" ? (
                            <section className="space-y-6">
                                <div>
                                    <h1 className="text-2xl font-semibold">
                                        {t("settings.groupManagement.title")}
                                    </h1>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        {t("settings.groupManagement.description")}
                                    </p>
                                </div>
                                <SettingsGroupManagement />
                            </section>
                        ) : null}
                        {section === "archived" ? (
                            <section className="space-y-6">
                                <div>
                                    <h1 className="text-2xl font-semibold">{t("settings.archived.title")}</h1>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        {t("settings.archived.description")}
                                    </p>
                                </div>
                                <div className="rounded-lg border p-2">
                                    <ArchivedChatList />
                                </div>
                            </section>
                        ) : null}
                    </div>
                </div>
            </div>
            <CreateApiKeyDialog
                open={showCreate}
                onOpenChange={setShowCreate}
                onCreated={(key) => {
                    setCreatedKey(key);
                    setRefreshKey((value) => value + 1);
                }}
            />
            <ApiKeyRevealDialog apiKey={createdKey} onOpenChange={(open) => !open && setCreatedKey(null)} />
            <CreateUserDialog
                open={showCreateUser}
                onOpenChange={setShowCreateUser}
                onCreated={() => setUserRefreshKey((key) => key + 1)}
            />
        </>
    );
}
