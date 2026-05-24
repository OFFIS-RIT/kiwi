"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AuthMode } from "@kiwi/auth/mode";

export type RuntimeConfig = {
    apiUrl: string;
    authUrl: string;
    authMode: AuthMode;
    buildLabel?: string;
};

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export function RuntimeConfigProvider({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
    return <RuntimeConfigContext.Provider value={config}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
    const ctx = useContext(RuntimeConfigContext);
    if (!ctx) {
        throw new Error("useRuntimeConfig must be used within RuntimeConfigProvider");
    }
    return ctx;
}
