"use client";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useLanguage } from "@/providers/LanguageProvider";
import { useTheme } from "@/providers/ThemeProvider";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useLanguage();
  const isDark = theme === "dark";

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        // Prevent the dropdown from closing
        e.preventDefault();
      }}
      className="flex items-center justify-between px-2 py-2"
    >
      <div className="flex items-center gap-2">
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        <span>{isDark ? t("theme.dark") : t("theme.light")}</span>
      </div>
      <Switch
        checked={isDark}
        onCheckedChange={() => setTheme(isDark ? "light" : "dark")}
      />
    </DropdownMenuItem>
  );
}
