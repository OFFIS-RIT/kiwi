"use client";

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setAutoLocale, setLocale } from "@/lib/i18n/set-locale";
import { Globe } from "lucide-react";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function LanguageSwitcher() {
    const locale = useLocale();
    const router = useRouter();
    const t = useAppTranslations();
    const [isPending, startTransition] = useTransition();

    const handleChange = (nextLocale: "de" | "en") => {
        startTransition(async () => {
            await setLocale(nextLocale);
            router.refresh();
        });
    };

    const handleAutoDetect = () => {
        startTransition(async () => {
            await setAutoLocale();
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
                <DropdownMenuItem disabled={isPending} onClick={handleAutoDetect}>
                    <span>{t("language.auto")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                    disabled={isPending}
                    onClick={() => handleChange("en")}
                    className={locale === "en" ? "bg-muted" : ""}
                >
                    <span>{t("english")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                    disabled={isPending}
                    onClick={() => handleChange("de")}
                    className={locale === "de" ? "bg-muted" : ""}
                >
                    <span>{t("german")}</span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
