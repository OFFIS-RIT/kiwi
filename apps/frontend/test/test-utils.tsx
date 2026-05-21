import { render, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";

import { AppMessagesProvider } from "@/lib/i18n/use-app-translations";
import deMessages from "@/messages/de.json";
import { ApiClientProvider } from "@/providers/ApiClientProvider";
import { AuthClientProvider } from "@/providers/AuthClientProvider";
import { RuntimeConfigProvider, type RuntimeConfig } from "@/providers/RuntimeConfigProvider";

const defaultConfig: RuntimeConfig = {
    apiUrl: "/api",
    authUrl: "/auth",
    authMode: "credentials",
};

export function renderWithProviders(
    ui: ReactElement,
    options?: RenderOptions & { config?: Partial<RuntimeConfig> }
) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const config = { ...defaultConfig, ...options?.config };
    const { config: _, ...renderOpts } = options ?? {};

    function Wrapper({ children }: { children: ReactNode }) {
        return (
            <RuntimeConfigProvider config={config}>
                <NextIntlClientProvider locale="de" messages={{}}>
                    <AppMessagesProvider messages={deMessages}>
                        <AuthClientProvider>
                            <ApiClientProvider>
                                <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
                            </ApiClientProvider>
                        </AuthClientProvider>
                    </AppMessagesProvider>
                </NextIntlClientProvider>
            </RuntimeConfigProvider>
        );
    }

    return render(ui, { wrapper: Wrapper, ...renderOpts });
}
