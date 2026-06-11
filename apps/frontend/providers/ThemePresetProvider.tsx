"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";

import {
    DEFAULT_THEME_PRESET_ID,
    THEME_PRESET_STORAGE_KEY,
    type ThemePresetId,
    normalizeThemePresetId,
} from "@/lib/theme-presets";

type ThemePresetContextValue = {
    themePreset: ThemePresetId;
    setThemePreset: (themePreset: ThemePresetId) => void;
};

type StoredThemePreset = {
    rawThemePreset: string | null;
    themePreset: ThemePresetId;
};

const ThemePresetContext = createContext<ThemePresetContextValue | null>(null);

function applyThemePreset(themePreset: ThemePresetId) {
    document.documentElement.dataset.themePreset = themePreset;
}

function readStoredThemePreset(): StoredThemePreset {
    if (typeof window === "undefined") {
        return { rawThemePreset: null, themePreset: DEFAULT_THEME_PRESET_ID };
    }

    try {
        const rawThemePreset = window.localStorage.getItem(THEME_PRESET_STORAGE_KEY);

        return {
            rawThemePreset,
            themePreset: normalizeThemePresetId(rawThemePreset),
        };
    } catch {
        return { rawThemePreset: null, themePreset: DEFAULT_THEME_PRESET_ID };
    }
}

export function ThemePresetProvider({ children }: { children: ReactNode }) {
    const [themePreset, setThemePresetState] = useState<ThemePresetId>(DEFAULT_THEME_PRESET_ID);

    useLayoutEffect(() => {
        const { rawThemePreset, themePreset: storedThemePreset } = readStoredThemePreset();
        setThemePresetState(storedThemePreset);
        applyThemePreset(storedThemePreset);
        try {
            if (rawThemePreset !== null && rawThemePreset !== storedThemePreset) {
                window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, storedThemePreset);
            }
        } catch {
            // Ignore storage access errors; the applied in-memory preset is still valid.
        }

        return () => {
            delete document.documentElement.dataset.themePreset;
        };
    }, []);

    const setThemePreset = useCallback((nextThemePreset: ThemePresetId) => {
        setThemePresetState(nextThemePreset);
        applyThemePreset(nextThemePreset);
        try {
            window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, nextThemePreset);
        } catch {
            // Keep the in-memory and DOM theme switch even when storage is blocked.
        }
    }, []);

    const value = useMemo(() => ({ themePreset, setThemePreset }), [themePreset, setThemePreset]);

    return <ThemePresetContext.Provider value={value}>{children}</ThemePresetContext.Provider>;
}

export function useThemePreset() {
    const context = useContext(ThemePresetContext);

    if (!context) {
        throw new Error("useThemePreset must be used within ThemePresetProvider");
    }

    return context;
}
