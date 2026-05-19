import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

const fakeUseSession = vi.fn().mockReturnValue({ data: null, isPending: false, error: null });
const fakeSignIn = {
    email: vi.fn().mockResolvedValue({}),
    credentials: vi.fn().mockResolvedValue({}),
};
const fakeSignOut = vi.fn();

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        useSession: fakeUseSession,
        signIn: fakeSignIn,
        signOut: fakeSignOut,
    })),
}));

import { AuthClientProvider } from "@/providers/AuthClientProvider";
import { LanguageProvider } from "@/providers/LanguageProvider";
import { RuntimeConfigProvider } from "@/providers/RuntimeConfigProvider";
import { LoginForm } from "./LoginForm";

function renderLoginForm(onSwitch = vi.fn()) {
    return render(
        <RuntimeConfigProvider config={{ apiUrl: "/api", authUrl: "/auth", authMode: "credentials" }}>
            <AuthClientProvider>
                <LanguageProvider>
                    <LoginForm onSwitchToRegister={onSwitch} />
                </LanguageProvider>
            </AuthClientProvider>
        </RuntimeConfigProvider>
    );
}

describe("LoginForm", () => {
    test("renders identifier and password fields", () => {
        renderLoginForm();
        expect(document.getElementById("identifier")).toBeInTheDocument();
        expect(document.getElementById("password")).toBeInTheDocument();
    });

    test("shows error when submitting empty form", async () => {
        renderLoginForm();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /sign.in|anmeld/i }));
        expect(document.querySelector(".text-destructive")).toBeInTheDocument();
    });

    test("has link to register in credentials mode", () => {
        const onSwitch = vi.fn();
        renderLoginForm(onSwitch);
        const buttons = screen.getAllByRole("button");
        expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
});
