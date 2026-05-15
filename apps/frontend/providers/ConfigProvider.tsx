import { createContext, useContext, type ReactNode } from "react";
import type { AppConfig } from "@/types/config";

const ConfigContext = createContext<AppConfig | null>(null);

export function useConfig(): AppConfig {
    const config = useContext(ConfigContext);
    if (!config) {
        throw new Error("useConfig must be used within a ConfigProvider");
    }
    return config;
}

type ConfigProviderProps = {
    config: AppConfig;
    children: ReactNode;
};

export function ConfigProvider({ config, children }: ConfigProviderProps) {
    return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}
