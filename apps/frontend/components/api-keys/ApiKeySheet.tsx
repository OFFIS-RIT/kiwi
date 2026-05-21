"use client";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { Plus } from "lucide-react";
import { useState } from "react";
import { ApiKeyRevealDialog } from "./ApiKeyRevealDialog";
import { ApiKeyList } from "./ApiKeyList";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";

type ApiKeySheetProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function ApiKeySheet({ open, onOpenChange }: ApiKeySheetProps) {
    const t = useAppTranslations();
    const [showCreate, setShowCreate] = useState(false);
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    return (
        <>
            <Sheet open={open} onOpenChange={onOpenChange}>
                <SheetContent className="w-full overflow-y-auto p-6 sm:max-w-lg">
                    <SheetHeader>
                        <SheetTitle>{t("apiKey.management")}</SheetTitle>
                        <SheetDescription>{t("apiKey.management.description")}</SheetDescription>
                    </SheetHeader>
                    <div className="space-y-3">
                        <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
                            <Plus className="mr-2 h-4 w-4" />
                            {t("apiKey.create")}
                        </Button>
                        <ApiKeyList key={refreshKey} />
                    </div>
                </SheetContent>
            </Sheet>
            <CreateApiKeyDialog
                open={showCreate}
                onOpenChange={setShowCreate}
                onCreated={(key) => {
                    setCreatedKey(key);
                    setRefreshKey((k) => k + 1);
                }}
            />
            <ApiKeyRevealDialog
                apiKey={createdKey}
                onOpenChange={(open) => {
                    if (!open) setCreatedKey(null);
                }}
            />
        </>
    );
}
