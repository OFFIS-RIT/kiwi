import { screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const fakeUseSession = vi.fn();
const fakeSignOut = vi.fn();

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        useSession: fakeUseSession,
        signOut: fakeSignOut,
    })),
}));

vi.mock("next/navigation", () => ({
    useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
}));

import { LanguageProvider } from "@/providers/LanguageProvider";
import { renderWithProviders } from "@/test/test-utils";
import { AuthProvider, useAuth } from "./AuthProvider";

function TestConsumer() {
    const { user, isAdmin, role } = useAuth();
    if (!user) {
        return <div>no-session</div>;
    }

    return (
        <div>
            <span data-testid="role">{role}</span>
            <span data-testid="admin">{isAdmin ? "yes" : "no"}</span>
        </div>
    );
}

function renderWithAuth(sessionData: unknown) {
    fakeUseSession.mockReturnValue(sessionData);

    return renderWithProviders(
        <LanguageProvider>
            <AuthProvider>
                <TestConsumer />
            </AuthProvider>
        </LanguageProvider>
    );
}

describe("AuthProvider", () => {
    test("shows loading when isPending", () => {
        renderWithAuth({ data: null, isPending: true, error: null });
        expect(screen.getByRole("img", { name: "KIWI" })).toBeInTheDocument();
        expect(screen.queryByText("no-session")).not.toBeInTheDocument();
    });

    test("renders children when session exists", () => {
        renderWithAuth({
            data: {
                user: { id: "1", name: "Test", email: "t@t.com", role: "admin" },
                session: {},
            },
            isPending: false,
            error: null,
        });

        expect(screen.getByTestId("role")).toHaveTextContent("admin");
        expect(screen.getByTestId("admin")).toHaveTextContent("yes");
    });

    test("shows login when no session", () => {
        renderWithAuth({ data: null, isPending: false, error: null });
        expect(screen.queryByTestId("role")).not.toBeInTheDocument();
    });
});
