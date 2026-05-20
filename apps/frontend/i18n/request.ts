import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

const SUPPORTED_LOCALES = ["de", "en"] as const;

type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(value: string | undefined): value is SupportedLocale {
    return value === "de" || value === "en";
}

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
    const locale: SupportedLocale = isSupportedLocale(cookieLocale) ? cookieLocale : "de";

    return {
        locale,
        messages: (await import(`@/messages/${locale}.json`)).default,
    };
});
