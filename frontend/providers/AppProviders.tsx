"use client";

import type { ReactNode } from "react";

import { AuthProvider } from "@/providers/AuthProvider";
import { LanguageProvider } from "@/providers/LanguageProvider";
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
    <AuthProvider>
      <ThemeProvider defaultTheme={defaultTheme}>
        <LanguageProvider>{children}</LanguageProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

export default AppProviders;
