export const THEME_PRESET_STORAGE_KEY = "kiwi-theme-preset";

export const DEFAULT_THEME_PRESET_ID = "default";

export const THEME_PRESET_EXCLUDED_PATH_PREFIXES = ["/login"] as const;

export const THEME_PRESETS = [
    {
        id: "default",
        labelKey: "appearance.design.default",
        swatches: ["#171717", "#f5f5f5", "#e5e5e5"],
    },
    {
        id: "doom-64",
        labelKey: "appearance.design.doom64",
        swatches: ["#b71c1c", "#556b2f", "#4682b4"],
    },
    {
        id: "t3-chat",
        labelKey: "appearance.design.t3Chat",
        swatches: ["#a84370", "#f1c4e6", "#efbdeb"],
    },
    {
        id: "twitter",
        labelKey: "appearance.design.twitter",
        swatches: ["#1e9df1", "#E3ECF6", "#e1eaef"],
    },
    {
        id: "claude-plus",
        labelKey: "appearance.design.claudePlus",
        swatches: ["#c96442", "#e9e6dc", "#dad9d4"],
    },
    {
        id: "codex-plus",
        labelKey: "appearance.design.codexPlus",
        swatches: ["#171717", "rgb(232 233 236)", "rgb(245 245 248)"],
    },
    {
        id: "light-green",
        labelKey: "appearance.design.lightGreen",
        swatches: ["#aff33e", "#334155", "#f0fdf4"],
    },
    {
        id: "violet-bloom",
        labelKey: "appearance.design.violetBloom",
        swatches: ["#7033ff", "#e2ebff", "#e7e7ee"],
    },
] as const;

export type ThemePresetId = (typeof THEME_PRESETS)[number]["id"];

export const THEME_PRESET_IDS = THEME_PRESETS.map((preset) => preset.id) as ThemePresetId[];

export const LEGACY_THEME_PRESET_ALIASES = {
    codex: "codex-plus",
} satisfies Record<string, ThemePresetId>;

export function isThemePresetId(value: unknown): value is ThemePresetId {
    return typeof value === "string" && THEME_PRESET_IDS.includes(value as ThemePresetId);
}

export function normalizeThemePresetId(value: unknown): ThemePresetId {
    if (isThemePresetId(value)) {
        return value;
    }

    if (typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGACY_THEME_PRESET_ALIASES, value)) {
        return LEGACY_THEME_PRESET_ALIASES[value as keyof typeof LEGACY_THEME_PRESET_ALIASES];
    }

    return DEFAULT_THEME_PRESET_ID;
}
