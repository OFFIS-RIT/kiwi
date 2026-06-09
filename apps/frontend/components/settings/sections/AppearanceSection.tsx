"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SupportedLocale } from "@/lib/i18n/locale";
import { clearLocale, setLocale } from "@/lib/i18n/set-locale";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { cn } from "@/lib/utils";
import { Monitor, Moon, Sun } from "lucide-react";
import { useLocale } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";

const THEME_OPTIONS = [
    { value: "light", icon: Sun, labelKey: "appearance.theme.light" },
    { value: "system", icon: Monitor, labelKey: "appearance.theme.system" },
    { value: "dark", icon: Moon, labelKey: "appearance.theme.dark" },
] as const;

function getExplicitLocale(): SupportedLocale | null {
    if (typeof document === "undefined") {
        return null;
    }

    const cookieLocale = document.cookie
        .split(";")
        .map((cookie) => cookie.trim())
        .find((cookie) => cookie.startsWith("NEXT_LOCALE="))
        ?.split("=")[1];

    return cookieLocale === "de" || cookieLocale === "en" ? cookieLocale : null;
}

function SettingRow({ title, description, control }: { title: string; description: string; control: ReactNode }) {
    return (
        <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="space-y-0.5">
                <p className="text-sm font-medium">{title}</p>
                <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <div className="shrink-0">{control}</div>
        </div>
    );
}

export function AppearanceSection() {
    const t = useAppTranslations();
    const router = useRouter();
    const locale = useLocale();
    const { theme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const [explicitLocale, setExplicitLocale] = useState<SupportedLocale | null | undefined>(undefined);
    const [isPending, startTransition] = useTransition();

    useEffect(() => {
        setMounted(true);
    }, []);

    useEffect(() => {
        setExplicitLocale(getExplicitLocale());
    }, [locale]);

    const activeTheme = mounted ? (theme ?? "system") : undefined;
    const languageValue = explicitLocale ?? "auto";

    const handleLanguageChange = (value: string) => {
        startTransition(async () => {
            if (value === "auto") {
                await clearLocale();
                setExplicitLocale(null);
            } else {
                await setLocale(value as SupportedLocale);
                setExplicitLocale(value as SupportedLocale);
            }
            router.refresh();
        });
    };

    return (
        <section className="flex max-w-2xl flex-col gap-6">
            <div>
                <h1 className="text-2xl font-bold">{t("appearance")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.appearance.description")}</p>
            </div>

            <Card>
                <CardContent className="flex flex-col divide-y">
                    <SettingRow
                        title={t("theme")}
                        description={t("appearance.theme.description")}
                        control={
                            <div className="inline-flex items-center rounded-lg border bg-muted p-0.5">
                                {THEME_OPTIONS.map((option) => {
                                    const Icon = option.icon;
                                    const isActive = activeTheme === option.value;
                                    return (
                                        <button
                                            key={option.value}
                                            type="button"
                                            onClick={() => setTheme(option.value)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                                                isActive
                                                    ? "bg-background text-foreground shadow-sm"
                                                    : "text-muted-foreground hover:text-foreground"
                                            )}
                                        >
                                            <Icon className="h-4 w-4" />
                                            <span>{t(option.labelKey)}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        }
                    />
                    <SettingRow
                        title={t("language")}
                        description={t("appearance.language.description")}
                        control={
                            <Select value={languageValue} onValueChange={handleLanguageChange} disabled={isPending}>
                                <SelectTrigger className="w-48">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="auto">{t("autoDetectLanguage")}</SelectItem>
                                    <SelectItem value="en">{t("english")}</SelectItem>
                                    <SelectItem value="de">{t("german")}</SelectItem>
                                </SelectContent>
                            </Select>
                        }
                    />
                </CardContent>
            </Card>
        </section>
    );
}
