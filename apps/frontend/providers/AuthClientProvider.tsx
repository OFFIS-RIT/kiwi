"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createKiwiAuthClient, type KiwiAuthClient } from "@kiwi/auth/client";
import { useRuntimeConfig } from "./RuntimeConfigProvider";

const AuthClientContext = createContext<KiwiAuthClient | null>(null);

export function AuthClientProvider({ children }: { children: ReactNode }) {
    const { authUrl } = useRuntimeConfig();
    const client = useMemo(() => createKiwiAuthClient(authUrl), [authUrl]);
    return <AuthClientContext.Provider value={client}>{children}</AuthClientContext.Provider>;
}

export function useAuthClient(): KiwiAuthClient {
    const ctx = useContext(AuthClientContext);
    if (!ctx) {
        throw new Error("useAuthClient must be used within AuthClientProvider");
    }
    return ctx;
}
