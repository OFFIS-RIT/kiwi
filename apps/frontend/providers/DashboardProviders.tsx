"use client";

import type { ReactNode } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import { AuthProvider } from "@/providers/AuthProvider";
import { ChatSessionsProvider } from "@/providers/ChatSessionsProvider";
import { DataProvider } from "@/providers/DataProvider";
import { LanguageProvider } from "@/providers/LanguageProvider";
import { QueryProvider } from "@/providers/QueryProvider";
import { SidebarExpansionProvider } from "@/providers/SidebarExpansionProvider";
import { ThemeProvider } from "@/providers/ThemeProvider";
import type { Group } from "@/types";

type DashboardProvidersProps = {
    session: {
        user: { id: string; name: string; email: string; role: string };
    };
    authMode: string;
    initialGroups: Group[];
    children: ReactNode;
};

export function DashboardProviders({ session, authMode, initialGroups, children }: DashboardProvidersProps) {
    return (
        <ThemeProvider defaultTheme="light">
            <LanguageProvider>
                <QueryProvider>
                    <AuthProvider initialSession={session} authMode={authMode}>
                        <DataProvider initialGroups={initialGroups}>
                            <ChatSessionsProvider>
                                <SidebarExpansionProvider>
                                    <SidebarProvider>{children}</SidebarProvider>
                                </SidebarExpansionProvider>
                            </ChatSessionsProvider>
                        </DataProvider>
                    </AuthProvider>
                </QueryProvider>
            </LanguageProvider>
        </ThemeProvider>
    );
}
