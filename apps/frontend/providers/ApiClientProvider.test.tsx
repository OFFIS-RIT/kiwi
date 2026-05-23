import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiClientProvider, useApiClient } from "./ApiClientProvider";
import { AuthClientProvider } from "./AuthClientProvider";
import { RuntimeConfigProvider } from "./RuntimeConfigProvider";

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({ _marker: "auth-client" })),
}));
vi.mock("@/lib/api/client", () => ({
    createKiwiApiClient: vi.fn((baseURL: string) => ({ baseURL })),
}));

function Probe() {
    const client = useApiClient();
    return <div data-testid="probe">{client.baseURL}</div>;
}

describe("ApiClientProvider", () => {
    it("creates client with apiUrl from RuntimeConfig", () => {
        render(
            <RuntimeConfigProvider
                config={{ apiUrl: "https://api.test", authUrl: "/auth", authMode: "credentials" }}
            >
                <AuthClientProvider>
                    <ApiClientProvider>
                        <Probe />
                    </ApiClientProvider>
                </AuthClientProvider>
            </RuntimeConfigProvider>
        );
        expect(screen.getByTestId("probe")).toHaveTextContent("https://api.test");
    });
});
