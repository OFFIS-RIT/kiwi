"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createKiwiApiClient, type KiwiApiClient } from "@/lib/api/client";
import { useAuthClient } from "./AuthClientProvider";
import { useRuntimeConfig } from "./RuntimeConfigProvider";

const ApiClientContext = createContext<KiwiApiClient | null>(null);

export function ApiClientProvider({ children }: { children: ReactNode }) {
    const { apiUrl } = useRuntimeConfig();
    const authClient = useAuthClient();
    const client = useMemo(() => createKiwiApiClient(apiUrl, authClient), [apiUrl, authClient]);
    return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): KiwiApiClient {
    const ctx = useContext(ApiClientContext);
    if (!ctx) throw new Error("useApiClient must be used within ApiClientProvider");
    return ctx;
}
