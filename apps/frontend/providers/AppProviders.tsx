import { type ReactNode, useMemo } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import type { AppConfig } from "@/types/config";
import { AuthProvider } from "@/providers/AuthProvider";
import { ChatSessionsProvider } from "@/providers/ChatSessionsProvider";
import { ConfigProvider } from "@/providers/ConfigProvider";
import { DataProvider } from "@/providers/DataProvider";
import { LanguageProvider } from "@/providers/LanguageProvider";
import { NavigationProvider } from "@/providers/NavigationProvider";
import { QueryErrorBoundary } from "@/providers/QueryErrorBoundary";
import { QueryProvider } from "@/providers/QueryProvider";
import { SidebarExpansionProvider } from "@/providers/SidebarExpansionProvider";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { initApiClient } from "@/lib/api/client";

type ThemeOption = React.ComponentProps<typeof ThemeProvider>["defaultTheme"];

type AppProvidersProps = {
    children: ReactNode;
    defaultTheme?: ThemeOption;
    config: AppConfig;
};

export function AppProviders({ children, defaultTheme = "light", config }: AppProvidersProps) {
    useMemo(() => {
        initApiClient(config.apiUrl);
    }, [config.apiUrl]);

    return (
        <ConfigProvider config={config}>
            <ThemeProvider defaultTheme={defaultTheme}>
                <LanguageProvider>
                    <QueryProvider>
                        <AuthProvider>
                            <QueryErrorBoundary>
                                <DataProvider>
                                    <ChatSessionsProvider>
                                        <SidebarExpansionProvider>
                                            <NavigationProvider>
                                                <SidebarProvider>{children}</SidebarProvider>
                                            </NavigationProvider>
                                        </SidebarExpansionProvider>
                                    </ChatSessionsProvider>
                                </DataProvider>
                            </QueryErrorBoundary>
                        </AuthProvider>
                    </QueryProvider>
                </LanguageProvider>
            </ThemeProvider>
        </ConfigProvider>
    );
}

export default AppProviders;
