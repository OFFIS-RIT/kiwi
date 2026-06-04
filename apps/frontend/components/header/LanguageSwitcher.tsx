"use client";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { clearLocale, setLocale } from "@/lib/i18n/set-locale";
import { Globe } from "lucide-react";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import type { SupportedLocale } from "@/lib/i18n/locale";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

function getExplicitLocale(): SupportedLocale | null {
    if (typeof document === "undefined") return null;

    const cookieLocale = document.cookie
        .split(";")
        .map((cookie) => cookie.trim())
        .find((cookie) => cookie.startsWith("NEXT_LOCALE="))
        ?.split("=")[1];

    return cookieLocale === "de" || cookieLocale === "en" ? cookieLocale : null;
}

export function LanguageSwitcher() {
    const locale = useLocale();
    const router = useRouter();
    const t = useAppTranslations();
    const [explicitLocale, setExplicitLocale] = useState<SupportedLocale | null>(null);
    const [isPending, startTransition] = useTransition();

    useEffect(() => {
        setExplicitLocale(getExplicitLocale());
    }, [locale]);

    const handleChange = (nextLocale: SupportedLocale) => {
        startTransition(async () => {
            await setLocale(nextLocale);
            setExplicitLocale(nextLocale);
            router.refresh();
        });
    };

    const handleAutoDetect = () => {
        startTransition(async () => {
            await clearLocale();
            setExplicitLocale(null);
            router.refresh();
        });
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Globe className="h-5 w-5" />
                    <span className="sr-only">{t("language")}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem
                    disabled={isPending}
                    onClick={() => handleChange("en")}
                    className={explicitLocale === "en" ? "bg-muted" : ""}
                >
                    <span>{t("english")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                    disabled={isPending}
                    onClick={() => handleChange("de")}
                    className={explicitLocale === "de" ? "bg-muted" : ""}
                >
                    <span>{t("german")}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    disabled={isPending}
                    onClick={handleAutoDetect}
                    className={explicitLocale === null ? "bg-muted" : ""}
                >
                    <span>{t("autoDetectLanguage")}</span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
