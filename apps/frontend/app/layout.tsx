import "@/app/globals.css";
import "katex/dist/katex.min.css";
import { Inter } from "next/font/google";
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

const SERVER_CONFIG: RuntimeConfig = {
    apiUrl: process.env.API_URL ?? "/api",
    authUrl: process.env.AUTH_URL ?? "/auth",
    authMode: (process.env.AUTH_MODE ?? "credentials") as "credentials" | "ldap",
    buildLabel: process.env.BUILD_LABEL?.trim() || undefined,
};

const themeScript = `(function(){try{var t=localStorage.getItem('ui-theme');if(t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                {/* eslint-disable-next-line react/no-danger */}
                <script dangerouslySetInnerHTML={{ __html: themeScript }} />
            </head>
            <body className={inter.className}>
                <RuntimeConfigProvider config={SERVER_CONFIG}>
                    <AuthClientProvider>
                        <ApiClientProvider>{children}</ApiClientProvider>
                    </AuthClientProvider>
                </RuntimeConfigProvider>
                <Toaster richColors expand position="bottom-center" duration={5000} />
            </body>
        </html>
    );
}
