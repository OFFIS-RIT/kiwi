"use client";

import { Button } from "@/components/ui/button";
import { useLanguage } from "@/providers/LanguageProvider";

export default function ProjectError({ error, reset }: { error: Error; reset: () => void }) {
    const { t } = useLanguage();

    return (
        <div className="flex h-full items-center justify-center p-4">
            <div className="max-w-md space-y-4 text-center">
                <h2 className="text-xl font-bold text-destructive">{t("error.something.went.wrong")}</h2>
                <p className="text-sm text-muted-foreground">{error.message}</p>
                <div className="flex gap-3 justify-center">
                    <Button variant="outline" onClick={reset}>
                        {t("try.again")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
