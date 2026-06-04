"use server";

import { cookies, headers } from "next/headers";

function isSecureRequest(headerStore: Awaited<ReturnType<typeof headers>>) {
    const forwardedProto = headerStore.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (forwardedProto === "https") return true;
    if (forwardedProto === "http") return false;

    const rawHost = headerStore.get("host") ?? "";
    const host = rawHost.startsWith("[") ? rawHost.slice(1, rawHost.indexOf("]")) : rawHost.split(":")[0];
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;

    return process.env.NODE_ENV === "production";
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
