export const SUPPORTED_LOCALES = ["de", "en"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const FALLBACK_LOCALE: SupportedLocale = "en";

export function isSupportedLocale(value: string | undefined): value is SupportedLocale {
    return value !== undefined && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function detectLocaleFromAcceptLanguage(acceptLanguage: string | null | undefined): SupportedLocale {
    if (!acceptLanguage) return FALLBACK_LOCALE;

    const preferredLocale = acceptLanguage
        .split(",")
        .map((rawValue, index) => {
            const [rawLanguage, ...rawOptions] = rawValue.trim().split(";");
            const qualityOption = rawOptions
                .map((option) => option.trim())
                .find((option) => option.toLowerCase().startsWith("q="));
            const rawQuality = qualityOption ? Number.parseFloat(qualityOption.slice(2)) : 1;
            const quality = Math.min(1, rawQuality);
            const baseLanguage = rawLanguage?.split("-")[0]?.toLowerCase();

            return {
                locale: isSupportedLocale(baseLanguage) ? baseLanguage : undefined,
                quality: Number.isFinite(quality) ? quality : 0,
                index,
            };
        })
        .filter((entry): entry is { locale: SupportedLocale; quality: number; index: number } => {
            return entry.locale !== undefined && entry.quality > 0;
        })
        .sort((left, right) => right.quality - left.quality || left.index - right.index)[0]?.locale;

    return preferredLocale ?? FALLBACK_LOCALE;
}
