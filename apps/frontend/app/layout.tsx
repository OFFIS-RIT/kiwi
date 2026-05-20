import "@/app/globals.css";
import "katex/dist/katex.min.css";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { RuntimeConfigProvider, type RuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { AuthClientProvider } from "@/providers/AuthClientProvider";
import { ApiClientProvider } from "@/providers/ApiClientProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
    title: "KI-basiertes Wissensmanagement",
    description: "Ein Dashboard zur Verwaltung von Wissensgruppen und -projekten",
};

function parseAuthMode(value: string | undefined): "credentials" | "ldap" {
    if (value === "credentials" || value === "ldap") return value;
    if (value !== undefined && value !== "") {
        console.warn(`Invalid AUTH_MODE "${value}", falling back to "credentials"`);
    }
    return "credentials";
}

const SERVER_CONFIG: RuntimeConfig = {
    apiUrl: process.env.API_URL ?? "/api",
    authUrl: process.env.AUTH_URL ?? "/auth",
    authMode: parseAuthMode(process.env.AUTH_MODE),
    buildLabel: process.env.BUILD_LABEL?.trim() || undefined,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
    const [locale, messages] = await Promise.all([getLocale(), getMessages()]);

    return (
        <html lang={locale} suppressHydrationWarning>
            <body className={inter.className}>
                <RuntimeConfigProvider config={SERVER_CONFIG}>
                    <NextIntlClientProvider messages={messages}>
                        <NextThemesProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
                            <AuthClientProvider>
                                <ApiClientProvider>{children}</ApiClientProvider>
                            </AuthClientProvider>
                        </NextThemesProvider>
                    </NextIntlClientProvider>
                </RuntimeConfigProvider>
                <Toaster richColors expand position="bottom-center" duration={5000} />
            </body>
        </html>
    );
}
