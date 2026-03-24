"use client";

import type { ReactNode } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import { AuthProvider } from "@/providers/AuthProvider";
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
};

export function AppProviders({
  children,
  defaultTheme = "light",
}: AppProvidersProps) {
  return (
    <ThemeProvider defaultTheme={defaultTheme}>
      <LanguageProvider>
        <QueryProvider>
          <AuthProvider>
            <QueryErrorBoundary>
              <DataProvider>
                <SidebarExpansionProvider>
                  <NavigationProvider>
                    <SidebarProvider>{children}</SidebarProvider>
                  </NavigationProvider>
                </SidebarExpansionProvider>
              </DataProvider>
            </QueryErrorBoundary>
          </AuthProvider>
        </QueryProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}

export default AppProviders;
