"use client";

import { PromptEditor } from "@/components/settings/PromptEditor";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";

export function PersonalizationSection() {
    const t = useAppTranslations();

    return (
        <section className="flex flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("settings.personalization.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.personalization.description")}</p>
            </div>

            <div className="flex flex-col gap-2">
                <div>
                    <h2 className="text-lg font-semibold">{t("settings.personalization.prompt.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("settings.personalization.prompt.description")}</p>
                </div>
                <PromptEditor scope={{ kind: "user", userId: "me" }} />
            </div>
        </section>
    );
}
