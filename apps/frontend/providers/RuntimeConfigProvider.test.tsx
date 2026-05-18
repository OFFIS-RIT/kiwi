import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuntimeConfigProvider, useRuntimeConfig } from "./RuntimeConfigProvider";

function Probe() {
    const config = useRuntimeConfig();
    return <div>{config.apiUrl}</div>;
}

describe("RuntimeConfigProvider", () => {
    it("provides config to descendants", () => {
        render(
            <RuntimeConfigProvider
                config={{ apiUrl: "https://api.example.com", authUrl: "/auth", authMode: "credentials" }}
            >
                <Probe />
            </RuntimeConfigProvider>
        );
        expect(screen.getByText("https://api.example.com")).toBeInTheDocument();
    });

    it("throws when used outside provider", () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(() => render(<Probe />)).toThrow(/useRuntimeConfig must be used within RuntimeConfigProvider/);
        err.mockRestore();
    });
});
