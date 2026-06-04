"use server";

import { cookies, headers } from "next/headers";

function isSecureRequest(headerStore: Awaited<ReturnType<typeof headers>>) {
    const forwardedProto = headerStore.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    return forwardedProto === "https";
}

export async function setLocale(locale: "de" | "en") {
    const cookieStore = await cookies();
    const headerStore = await headers();

    cookieStore.set("NEXT_LOCALE", locale, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
        secure: isSecureRequest(headerStore),
        httpOnly: false,
    });
}
