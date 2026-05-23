import { cache } from "react";
import { headers } from "next/headers";
import type { KiwiAuthClient } from "@kiwi/auth/client";
import { fetchSessionRaw } from "./transport";
import "server-only";

type SessionResponse = NonNullable<
    Awaited<ReturnType<KiwiAuthClient["getSession"]>>["data"]
>;

export const getServerSession = cache(async (): Promise<SessionResponse | null> => {
    const url = process.env.INTERNAL_AUTH_URL ?? process.env.AUTH_URL ?? "";
    if (!url) return null;
    const cookie = (await headers()).get("cookie") ?? "";
    const data = (await fetchSessionRaw(url, cookie)) as SessionResponse | null;
    return data?.user ? data : null;
});
