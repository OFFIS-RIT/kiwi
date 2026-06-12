"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";

import { DEFAULT_FONT_SIZE_ID, FONT_SIZE_STORAGE_KEY, type FontSizeId, normalizeFontSizeId } from "@/lib/font-sizes";
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

type FontSizeContextValue = {
    fontSize: FontSizeId;
    setFontSize: (fontSize: FontSizeId) => void;
};

type StoredFontSize = {
    rawFontSize: string | null;
    fontSize: FontSizeId;
};

const ThemePresetContext = createContext<ThemePresetContextValue | null>(null);

const FontSizeContext = createContext<FontSizeContextValue | null>(null);

function applyThemePreset(themePreset: ThemePresetId) {
    document.documentElement.dataset.themePreset = themePreset;
}

function applyFontSize(fontSize: FontSizeId) {
    document.documentElement.dataset.fontSize = fontSize;
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

function readStoredFontSize(): StoredFontSize {
    if (typeof window === "undefined") {
        return { rawFontSize: null, fontSize: DEFAULT_FONT_SIZE_ID };
    }

    try {
        const rawFontSize = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);

        return {
            rawFontSize,
            fontSize: normalizeFontSizeId(rawFontSize),
        };
    } catch {
        return { rawFontSize: null, fontSize: DEFAULT_FONT_SIZE_ID };
    }
}

export function ThemePresetProvider({ children }: { children: ReactNode }) {
    const [themePreset, setThemePresetState] = useState<ThemePresetId>(DEFAULT_THEME_PRESET_ID);
    const [fontSize, setFontSizeState] = useState<FontSizeId>(DEFAULT_FONT_SIZE_ID);

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

    useLayoutEffect(() => {
        const { rawFontSize, fontSize: storedFontSize } = readStoredFontSize();
        setFontSizeState(storedFontSize);
        applyFontSize(storedFontSize);
        try {
            if (rawFontSize !== null && rawFontSize !== storedFontSize) {
                window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, storedFontSize);
            }
        } catch {
            // Ignore storage access errors; the applied in-memory font size is still valid.
        }

        return () => {
            delete document.documentElement.dataset.fontSize;
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

    const setFontSize = useCallback((nextFontSize: FontSizeId) => {
        setFontSizeState(nextFontSize);
        applyFontSize(nextFontSize);
        try {
            window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, nextFontSize);
        } catch {
            // Keep the in-memory and DOM font size switch even when storage is blocked.
        }
    }, []);

    const value = useMemo(() => ({ themePreset, setThemePreset }), [themePreset, setThemePreset]);
    const fontSizeValue = useMemo(() => ({ fontSize, setFontSize }), [fontSize, setFontSize]);

    return (
        <ThemePresetContext.Provider value={value}>
            <FontSizeContext.Provider value={fontSizeValue}>{children}</FontSizeContext.Provider>
        </ThemePresetContext.Provider>
    );
}

export function useThemePreset() {
    const context = useContext(ThemePresetContext);

    if (!context) {
        throw new Error("useThemePreset must be used within ThemePresetProvider");
    }

    return context;
}

export function useFontSize() {
    const context = useContext(FontSizeContext);

    if (!context) {
        throw new Error("useFontSize must be used within ThemePresetProvider");
    }

    return context;
}
