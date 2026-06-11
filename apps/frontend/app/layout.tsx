import "@/app/globals.css";
import "katex/dist/katex.min.css";
import { Geist_Mono, Inter, Open_Sans, Outfit, Oxanium, Source_Code_Pro } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { deriveAuthModeFromPresence } from "@kiwi/auth/mode";
import { AppMessagesProvider } from "@/lib/i18n/use-app-translations";
import { RuntimeConfigProvider, type RuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { AuthClientProvider } from "@/providers/AuthClientProvider";
import { ApiClientProvider } from "@/providers/ApiClientProvider";
import { ThemePresetScript } from "@/components/theme/ThemePresetScript";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const openSans = Open_Sans({ subsets: ["latin"], variable: "--font-open-sans" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });
const oxanium = Oxanium({ subsets: ["latin"], variable: "--font-oxanium" });
const sourceCodePro = Source_Code_Pro({ subsets: ["latin"], variable: "--font-source-code-pro" });

export const metadata: Metadata = {
    title: "KI-basiertes Wissensmanagement",
    description: "Ein Dashboard zur Verwaltung von Wissensgruppen und -projekten",
};

const SERVER_CONFIG: RuntimeConfig = {
    apiUrl: process.env.API_URL ?? "/api",
    authUrl: process.env.AUTH_URL ?? "/auth",
    authMode: deriveAuthModeFromPresence(process.env),
    buildLabel: process.env.BUILD_LABEL?.trim() || undefined,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
    const locale = await getLocale();
    const messages = (await import(`@/messages/${locale}.json`)).default;

    return (
        <html
            lang={locale}
            className={`${inter.variable} ${geistMono.variable} ${openSans.variable} ${outfit.variable} ${oxanium.variable} ${sourceCodePro.variable}`}
            suppressHydrationWarning
        >
            <body>
                <ThemePresetScript />
                <RuntimeConfigProvider config={SERVER_CONFIG}>
                    <NextIntlClientProvider locale={locale} messages={{}}>
                        <AppMessagesProvider messages={messages}>
                            <NextThemesProvider
                                attribute="class"
                                defaultTheme="system"
                                enableSystem
                                disableTransitionOnChange
                            >
                                <AuthClientProvider>
                                    <ApiClientProvider>{children}</ApiClientProvider>
                                </AuthClientProvider>
                            </NextThemesProvider>
                        </AppMessagesProvider>
                    </NextIntlClientProvider>
                </RuntimeConfigProvider>
                <Toaster richColors expand position="bottom-center" duration={5000} />
            </body>
        </html>
    );
}
