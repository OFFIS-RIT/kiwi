import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

const SUPPORTED_LOCALES = ["de", "en"] as const;

type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(value: string | undefined): value is SupportedLocale {
    return value === "de" || value === "en";
}

function detectLocale(acceptLanguage: string | undefined): SupportedLocale {
    const preferredLocales = (acceptLanguage ?? "")
        .split(",")
        .map((part, index) => {
            const [locale, ...options] = part.trim().split(";");
            const qualityOption = options.find((option) => option.trim().startsWith("q="));
            const quality = qualityOption
                ? Number.parseFloat(qualityOption.split("=")[1] ?? "")
                : 1;

            return {
                locale: locale?.toLowerCase(),
                quality: Number.isFinite(quality) ? quality : 0,
                index,
            };
        })
        .filter((preferredLocale) => preferredLocale.locale)
        .sort((left, right) => right.quality - left.quality || left.index - right.index);

    for (const preferredLocale of preferredLocales) {
        const locale = preferredLocale.locale?.split("-")[0];

        if (isSupportedLocale(locale)) {
            return locale;
        }
    }

    return "de";
}

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const headersStore = await headers();
    const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
    const locale: SupportedLocale = isSupportedLocale(cookieLocale)
        ? cookieLocale
        : detectLocale(headersStore.get("accept-language") ?? undefined);

    return {
        locale,
        messages: {},
    };
});
