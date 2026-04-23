"use client";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/providers/LanguageProvider";
import { useTheme } from "@/providers/ThemeProvider";
import { Monitor, Moon, Sun } from "lucide-react";

export function ThemeToggle() {
    const { theme, setTheme } = useTheme();
    const { t } = useLanguage();

    return (
        <DropdownMenuItem
            onSelect={(e) => {
                e.preventDefault();
            }}
            className="flex items-center justify-between gap-4"
        >
            <span>{t("theme")}</span>
            <div className="flex items-center rounded border bg-muted">
                <button
                    type="button"
                    onClick={() => setTheme("light")}
                    className={`rounded px-1.5 py-0.5 transition-colors ${
                        theme === "light" ? "bg-background shadow-sm" : "hover:bg-background/50"
                    }`}
                >
                    <Sun className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={() => setTheme("system")}
                    className={`rounded px-1.5 py-0.5 transition-colors ${
                        theme === "system" ? "bg-background shadow-sm" : "hover:bg-background/50"
                    }`}
                >
                    <Monitor className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={() => setTheme("dark")}
                    className={`rounded px-1.5 py-0.5 transition-colors ${
                        theme === "dark" ? "bg-background shadow-sm" : "hover:bg-background/50"
                    }`}
                >
                    <Moon className="h-3.5 w-3.5" />
                </button>
            </div>
        </DropdownMenuItem>
    );
}
