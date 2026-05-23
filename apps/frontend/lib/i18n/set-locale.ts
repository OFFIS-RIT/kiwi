"use server";

import { cookies } from "next/headers";

export async function setLocale(locale: "de" | "en") {
    const cookieStore = await cookies();
    cookieStore.set("NEXT_LOCALE", locale, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        httpOnly: false,
    });
}
