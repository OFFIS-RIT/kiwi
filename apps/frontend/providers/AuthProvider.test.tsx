import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@kiwi/auth/client", () => ({
    authClient: {
        useSession: vi.fn(),
        signOut: vi.fn(),
    },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { authClient } from "@kiwi/auth/client";
import { LanguageProvider } from "@/providers/LanguageProvider";
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
    (authClient.useSession as ReturnType<typeof vi.fn>).mockReturnValue(sessionData);
    const queryClient = new QueryClient();

    return render(
        <QueryClientProvider client={queryClient}>
            <LanguageProvider>
                <AuthProvider>
                    <TestConsumer />
                </AuthProvider>
            </LanguageProvider>
        </QueryClientProvider>
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
