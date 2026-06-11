"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SupportedLocale } from "@/lib/i18n/locale";
import { clearLocale, setLocale } from "@/lib/i18n/set-locale";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { THEME_PRESETS, isThemePresetId } from "@/lib/theme-presets";
import { cn } from "@/lib/utils";
import { useThemePreset } from "@/providers/ThemePresetProvider";
import { Monitor, Moon, Sun } from "lucide-react";
import { useLocale } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";

const COLOR_MODE_OPTIONS = [
    { value: "light", icon: Sun, labelKey: "appearance.colorMode.light" },
    { value: "system", icon: Monitor, labelKey: "appearance.colorMode.system" },
    { value: "dark", icon: Moon, labelKey: "appearance.colorMode.dark" },
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

function ThemePresetSwatches({ swatches }: { swatches: readonly string[] }) {
    return (
        <span className="flex items-center gap-0.5">
            {swatches.map((swatch) => (
                <span
                    key={swatch}
                    className="size-3 rounded-sm border border-border"
                    style={{ backgroundColor: swatch }}
                    aria-hidden="true"
                />
            ))}
        </span>
    );
}

export function AppearanceSection() {
    const t = useAppTranslations();
    const router = useRouter();
    const locale = useLocale();
    const { theme, setTheme } = useTheme();
    const { themePreset, setThemePreset } = useThemePreset();
    const [mounted, setMounted] = useState(false);
    const [explicitLocale, setExplicitLocale] = useState<SupportedLocale | null | undefined>(undefined);
    const [isPending, startTransition] = useTransition();

    useEffect(() => {
        setMounted(true);
    }, []);

    useEffect(() => {
        setExplicitLocale(getExplicitLocale());
    }, [locale]);

    const activeColorMode = mounted ? (theme ?? "system") : undefined;
    const languageValue = explicitLocale ?? "auto";

    const handleThemePresetChange = (value: string) => {
        if (isThemePresetId(value)) {
            setThemePreset(value);
        }
    };

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
                        title={t("appearance.design.title")}
                        description={t("appearance.design.description")}
                        control={
                            <Select
                                value={mounted ? themePreset : undefined}
                                onValueChange={handleThemePresetChange}
                                disabled={!mounted}
                            >
                                <SelectTrigger className="w-56">
                                    <SelectValue placeholder={t("appearance.design.title")} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        {THEME_PRESETS.map((preset) => (
                                            <SelectItem key={preset.id} value={preset.id}>
                                                <span className="flex items-center gap-2">
                                                    <ThemePresetSwatches swatches={preset.swatches} />
                                                    <span>{t(preset.labelKey)}</span>
                                                </span>
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        }
                    />
                    <SettingRow
                        title={t("appearance.colorMode.title")}
                        description={t("appearance.colorMode.description")}
                        control={
                            <div className="inline-flex items-center rounded-lg border bg-muted p-0.5">
                                {COLOR_MODE_OPTIONS.map((option) => {
                                    const Icon = option.icon;
                                    const isActive = activeColorMode === option.value;
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
                                    <SelectGroup>
                                        <SelectItem value="auto">{t("autoDetectLanguage")}</SelectItem>
                                        <SelectItem value="en">{t("english")}</SelectItem>
                                        <SelectItem value="de">{t("german")}</SelectItem>
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        }
                    />
                </CardContent>
            </Card>
        </section>
    );
}
