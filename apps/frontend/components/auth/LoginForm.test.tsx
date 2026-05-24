import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { AuthMode } from "@kiwi/auth/mode";

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

vi.mock("next/navigation", () => ({
    useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
}));

import { renderWithProviders } from "@/test/test-utils";
import { LoginForm } from "./LoginForm";

function renderLoginForm({
    authMode = "credentials",
    onSwitch = vi.fn(),
}: { authMode?: AuthMode; onSwitch?: () => void } = {}) {
    return renderWithProviders(<LoginForm onSwitchToRegister={onSwitch} />, { config: { authMode } });
}

describe("LoginForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

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
        renderLoginForm({ onSwitch });
        const buttons = screen.getAllByRole("button");
        expect(buttons.length).toBeGreaterThanOrEqual(2);
    });

    test("renders username field and no register link in LDAP mode", () => {
        renderLoginForm({ authMode: "ldap" });
        expect(screen.getByLabelText(/username|benutzername/i)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /sign.up|registrier/i })).not.toBeInTheDocument();
    });

    test("uses LDAP credentials sign-in path in LDAP mode", async () => {
        fakeSignIn.credentials.mockResolvedValueOnce({
            error: { message: "Invalid credentials" },
        });
        renderLoginForm({ authMode: "ldap" });
        const user = userEvent.setup();

        await user.type(screen.getByLabelText(/username|benutzername/i), "ldap-user");
        await user.type(screen.getByLabelText(/password|passwort/i), "secret");
        await user.click(screen.getByRole("button", { name: /sign.in|anmeld/i }));

        expect(fakeSignIn.credentials).toHaveBeenCalledWith({
            credential: "ldap-user",
            password: "secret",
            rememberMe: false,
        });
        expect(fakeSignIn.email).not.toHaveBeenCalled();
    });
});
