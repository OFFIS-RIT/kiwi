"use client";

import { ApiKeyList } from "@/components/api-keys/ApiKeyList";
import { ApiKeyRevealDialog } from "@/components/api-keys/ApiKeyRevealDialog";
import { CreateApiKeyDialog } from "@/components/api-keys/CreateApiKeyDialog";
import { ArchivedChatList } from "./ArchivedChatList";
import { LanguageSwitcher } from "@/components/header/LanguageSwitcher";
import { ThemeToggle } from "@/components/header/ThemeToggle";
import { Button } from "@/components/ui/button";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { Plus } from "lucide-react";
import { useState } from "react";

export function SettingsView() {
    const t = useAppTranslations();
    const [showCreate, setShowCreate] = useState(false);
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    return (
        <>
            <div className="h-full overflow-y-auto">
                <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
                    <div>
                        <h1 className="text-2xl font-bold">{t("settings")}</h1>
                    </div>
                    <section className="space-y-3">
                        <h2 className="text-lg font-semibold">{t("appearance")}</h2>
                        <div className="flex items-center gap-2">
                            <ThemeToggle asMenuItem={false} />
                            <LanguageSwitcher />
                        </div>
                    </section>
                    <section className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-lg font-semibold">{t("apiKey.management")}</h2>
                                <p className="text-sm text-muted-foreground">{t("apiKey.management.description")}</p>
                            </div>
                            <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
                                <Plus className="mr-2 h-4 w-4" />
                                {t("apiKey.create")}
                            </Button>
                        </div>
                        <ApiKeyList key={refreshKey} />
                    </section>
                    <section className="space-y-3">
                        <div>
                            <h2 className="text-lg font-semibold">{t("settings.archived.title")}</h2>
                            <p className="text-sm text-muted-foreground">{t("settings.archived.description")}</p>
                        </div>
                        <ArchivedChatList />
                    </section>
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
        </>
    );
}
