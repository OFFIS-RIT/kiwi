"use client";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useAppTranslations } from "@/lib/i18n/use-app-translations";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type ThemeToggleProps = {
    asMenuItem?: boolean;
};

export function ThemeToggle({ asMenuItem = true }: ThemeToggleProps) {
    const { theme, setTheme } = useTheme();
    const t = useAppTranslations();
    const [mounted, setMounted] = useState(false);
    const activeTheme = mounted ? theme : undefined;

    useEffect(() => {
        setMounted(true);
    }, []);

    const content: ReactNode = (
        <>
            <span>{t("appearance.colorMode.title")}</span>
            <div className="flex items-center rounded border bg-muted">
                <button
                    type="button"
                    onClick={() => setTheme("light")}
                    className={`rounded px-1.5 py-0.5 transition-colors ${
                        activeTheme === "light" ? "bg-background shadow-sm" : "hover:bg-background/50"
                    }`}
                >
                    <Sun className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={() => setTheme("system")}
                    className={`rounded px-1.5 py-0.5 transition-colors ${
                        activeTheme === "system" ? "bg-background shadow-sm" : "hover:bg-background/50"
                    }`}
                >
                    <Monitor className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={() => setTheme("dark")}
                    className={`rounded px-1.5 py-0.5 transition-colors ${
                        activeTheme === "dark" ? "bg-background shadow-sm" : "hover:bg-background/50"
                    }`}
                >
                    <Moon className="h-3.5 w-3.5" />
                </button>
            </div>
        </>
    );

    if (!asMenuItem) {
        return (
            <div className="flex h-9 items-center justify-between gap-4 rounded-md border px-3 text-sm">
                {content}
            </div>
        );
    }

    return (
        <DropdownMenuItem
            onSelect={(e) => {
                e.preventDefault();
            }}
            className="flex items-center justify-between gap-4"
        >
            {content}
        </DropdownMenuItem>
    );
}
