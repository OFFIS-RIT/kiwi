"use client";

import { Button } from "@/components/ui/button";
import { useLanguage } from "@/providers/LanguageProvider";

export default function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
    const { t } = useLanguage();

    return (
        <div className="flex h-screen items-center justify-center bg-background">
            <div className="max-w-md space-y-4 text-center p-6">
                <div className="space-y-2">
                    <h1 className="text-2xl font-bold text-destructive">{t("error.something.went.wrong")}</h1>
                    <p className="text-muted-foreground">{t("error.unexpected.try.again")}</p>
                </div>
                {error.message && (
                    <div className="bg-destructive/10 border border-destructive/20 rounded-md p-4 text-left">
                        <p className="text-sm font-mono text-destructive break-words">{error.message}</p>
                    </div>
                )}
                <div className="flex gap-3 justify-center">
                    <Button variant="outline" onClick={reset}>
                        {t("try.again")}
                    </Button>
                    <Button onClick={() => window.location.reload()}>{t("reload.page")}</Button>
                </div>
            </div>
        </div>
    );
}
