"use client";

import { ApiKeyList } from "@/components/api-keys/ApiKeyList";
import { ApiKeyRevealDialog } from "@/components/api-keys/ApiKeyRevealDialog";
import { CreateApiKeyDialog } from "@/components/api-keys/CreateApiKeyDialog";
import { Button } from "@/components/ui/button";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { Plus } from "lucide-react";
import { useState } from "react";

export function ApiKeysSection() {
    const t = useAppTranslations();
    const [showCreate, setShowCreate] = useState(false);
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    return (
        <section className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold">{t("apiKey.management")}</h1>
                    <p className="text-sm text-muted-foreground">{t("apiKey.management.description")}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t("apiKey.create")}
                </Button>
            </div>
            <ApiKeyList key={refreshKey} />
            <CreateApiKeyDialog
                open={showCreate}
                onOpenChange={setShowCreate}
                onCreated={(key) => {
                    setCreatedKey(key);
                    setRefreshKey((value) => value + 1);
                }}
            />
            <ApiKeyRevealDialog apiKey={createdKey} onOpenChange={(open) => !open && setCreatedKey(null)} />
        </section>
    );
}
