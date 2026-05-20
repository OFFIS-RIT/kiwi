"use client";

import type { ReactNode } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import type { InitialClientSession } from "@/lib/auth/types";
import { AuthProvider } from "@/providers/AuthProvider";
import { ChatSessionsProvider } from "@/providers/ChatSessionsProvider";
import { DataProvider } from "@/providers/DataProvider";
import { LanguageProvider } from "@/providers/LanguageProvider";
import { QueryErrorBoundary } from "@/providers/QueryErrorBoundary";
import { QueryProvider } from "@/providers/QueryProvider";
import { SidebarExpansionProvider } from "@/providers/SidebarExpansionProvider";
import { ThemeProvider } from "@/providers/ThemeProvider";

type AppShellProps = {
    initialSession: InitialClientSession;
    children: ReactNode;
};

export function AppShell({ initialSession, children }: AppShellProps) {
    return (
        <ThemeProvider defaultTheme="light">
            <LanguageProvider>
                <QueryProvider>
                    <AuthProvider initialSession={initialSession}>
                        <QueryErrorBoundary>
                            <DataProvider>
                                <ChatSessionsProvider>
                                    <SidebarExpansionProvider>
                                        <SidebarProvider>{children}</SidebarProvider>
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
