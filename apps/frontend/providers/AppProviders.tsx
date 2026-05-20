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

type AppProvidersProps = {
    children: ReactNode;
    initialSession?: InitialClientSession;
};

const fallbackInitialSession: InitialClientSession = {
    user: { id: "", name: "", email: "", image: null, role: null },
};

export function AppProviders({ children, initialSession }: AppProvidersProps) {
    return (
        <LanguageProvider>
            <QueryProvider>
                <AuthProvider initialSession={initialSession ?? fallbackInitialSession}>
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
    );
}

export default AppProviders;
