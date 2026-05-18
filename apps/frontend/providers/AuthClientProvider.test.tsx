import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthClientProvider, useAuthClient } from "./AuthClientProvider";
import { RuntimeConfigProvider } from "./RuntimeConfigProvider";

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn((baseURL: string) => ({ baseURL, _marker: "client" })),
}));

function Probe() {
    const client = useAuthClient();
    return <div data-testid="probe">{JSON.stringify(client)}</div>;
}

describe("AuthClientProvider", () => {
    it("creates client with authUrl from RuntimeConfig", () => {
        render(
            <RuntimeConfigProvider
                config={{ apiUrl: "/api", authUrl: "https://auth.test/auth", authMode: "credentials" }}
            >
                <AuthClientProvider>
                    <Probe />
                </AuthClientProvider>
            </RuntimeConfigProvider>
        );
        expect(screen.getByTestId("probe")).toHaveTextContent('"baseURL":"https://auth.test/auth"');
    });

    it("throws when used outside provider", () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(() => render(<Probe />)).toThrow(/useAuthClient must be used within AuthClientProvider/);
        err.mockRestore();
    });
});
