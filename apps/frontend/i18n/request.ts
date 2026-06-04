import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { detectLocaleFromAcceptLanguage, isSupportedLocale } from "@/lib/i18n/locale";

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const headerStore = await headers();
    const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
    const locale = isSupportedLocale(cookieLocale)
        ? cookieLocale
        : detectLocaleFromAcceptLanguage(headerStore.get("accept-language"));

    return {
        locale,
        messages: {},
    };
});
