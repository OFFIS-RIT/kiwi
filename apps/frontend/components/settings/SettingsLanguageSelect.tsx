"use client";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { setAutoLocale, setLocale } from "@/lib/i18n/set-locale";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

type LocalePreference = "auto" | "de" | "en";

function getLocalePreference(): LocalePreference {
    const cookieLocale = document.cookie
        .split(";")
        .map((cookie) => cookie.trim())
        .find((cookie) => cookie.startsWith("NEXT_LOCALE="))
        ?.split("=")[1];

    return cookieLocale === "de" || cookieLocale === "en" ? cookieLocale : "auto";
}

export function SettingsLanguageSelect() {
    const router = useRouter();
    const t = useAppTranslations();
    const [isPending, startTransition] = useTransition();
    const [preference, setPreference] = useState<LocalePreference>("auto");

    useEffect(() => {
        setPreference(getLocalePreference());
    }, []);

    const handleChange = (nextPreference: LocalePreference) => {
        setPreference(nextPreference);

        startTransition(async () => {
            if (nextPreference === "auto") {
                await setAutoLocale();
            } else {
                await setLocale(nextPreference);
            }

            router.refresh();
        });
    };

    return (
        <Select value={preference} onValueChange={handleChange} disabled={isPending}>
            <SelectTrigger className="w-full sm:w-56">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="auto">{t("language.auto")}</SelectItem>
                <SelectItem value="de">{t("german")}</SelectItem>
                <SelectItem value="en">{t("english")}</SelectItem>
            </SelectContent>
        </Select>
    );
}
