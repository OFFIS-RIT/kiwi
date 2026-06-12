export const FONT_SIZE_STORAGE_KEY = "kiwi-font-size";

export const DEFAULT_FONT_SIZE_ID = "default";

export const FONT_SIZES = [
    {
        id: "compact",
        labelKey: "appearance.fontSize.compact",
        scale: 0.9,
    },
    {
        id: "default",
        labelKey: "appearance.fontSize.default",
        scale: 1,
    },
    {
        id: "large",
        labelKey: "appearance.fontSize.large",
        scale: 1.1,
    },
    {
        id: "x-large",
        labelKey: "appearance.fontSize.xLarge",
        scale: 1.25,
    },
] as const;

export type FontSizeId = (typeof FONT_SIZES)[number]["id"];

export const FONT_SIZE_IDS = FONT_SIZES.map((fontSize) => fontSize.id) as FontSizeId[];

export function isFontSizeId(value: unknown): value is FontSizeId {
    return typeof value === "string" && FONT_SIZE_IDS.includes(value as FontSizeId);
}

export function normalizeFontSizeId(value: unknown): FontSizeId {
    if (isFontSizeId(value)) {
        return value;
    }

    return DEFAULT_FONT_SIZE_ID;
}
