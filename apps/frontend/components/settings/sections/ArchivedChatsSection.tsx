"use client";

import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { ArchivedChatList } from "../ArchivedChatList";

export function ArchivedChatsSection() {
    const t = useAppTranslations();

    return (
        <section className="flex flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("settings.archived.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.archived.description")}</p>
            </div>
            <ArchivedChatList />
        </section>
    );
}
