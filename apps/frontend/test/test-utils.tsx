import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeConfigProvider, type RuntimeConfig } from "@/providers/RuntimeConfigProvider";
import { AuthClientProvider } from "@/providers/AuthClientProvider";
import { ApiClientProvider } from "@/providers/ApiClientProvider";

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
                <AuthClientProvider>
                    <ApiClientProvider>
                        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
                    </ApiClientProvider>
                </AuthClientProvider>
            </RuntimeConfigProvider>
        );
    }

    return render(ui, { wrapper: Wrapper, ...renderOpts });
}
