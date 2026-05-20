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

type AppShellProps = {
    initialSession: InitialClientSession;
    children: ReactNode;
};

export function AppShell({ initialSession: _initialSession, children }: AppShellProps) {
    // Note: initialSession wird in Task 3.6 an AuthProvider weitergereicht.
    // Heute akzeptieren wir es nur als Prop; der AuthProvider funktioniert weiterhin
    // mit seinem Client-only useSession-Hook.
    return (
        <ThemeProvider defaultTheme="light">
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
    );
}
