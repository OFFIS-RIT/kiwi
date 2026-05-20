"use client";

import type { ReactNode } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import type { InitialClientSession } from "@/lib/auth/types";
import { AuthProvider } from "@/providers/AuthProvider";
import { ChatSessionsProvider } from "@/providers/ChatSessionsProvider";
import { DataProvider } from "@/providers/DataProvider";
import { LanguageProvider } from "@/providers/LanguageProvider";
import { NavigationProvider } from "@/providers/NavigationProvider";
import { QueryErrorBoundary } from "@/providers/QueryErrorBoundary";
import { QueryProvider } from "@/providers/QueryProvider";
import { SidebarExpansionProvider } from "@/providers/SidebarExpansionProvider";
import { ThemeProvider } from "@/providers/ThemeProvider";

type ThemeOption = React.ComponentProps<typeof ThemeProvider>["defaultTheme"];

type AppProvidersProps = {
    children: ReactNode;
    defaultTheme?: ThemeOption;
    initialSession?: InitialClientSession;
};

const fallbackInitialSession: InitialClientSession = {
    user: { id: "", name: "", email: "", image: null, role: null },
};

export function AppProviders({ children, defaultTheme = "light", initialSession }: AppProvidersProps) {
    return (
        <ThemeProvider defaultTheme={defaultTheme}>
            <LanguageProvider>
                <QueryProvider>
                    <AuthProvider initialSession={initialSession ?? fallbackInitialSession}>
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
    );
}

export default AppProviders;
