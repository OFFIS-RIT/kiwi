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

const fakeRouterRefresh = vi.fn();
const fakeRouterReplace = vi.fn();

vi.mock("next/navigation", () => ({
    useRouter: vi.fn(() => ({
        push: vi.fn(),
        replace: fakeRouterReplace,
        refresh: fakeRouterRefresh,
    })),
}));

import type { InitialClientSession } from "@/lib/auth/types";
import { LanguageProvider } from "@/providers/LanguageProvider";
import { renderWithProviders } from "@/test/test-utils";
import { AuthProvider, useAuth } from "./AuthProvider";

function TestConsumer() {
    const { user, isAdmin, role, isPending } = useAuth();
    if (!user) {
        return <div>no-user</div>;
    }

    return (
        <div>
            <span data-testid="role">{role}</span>
            <span data-testid="admin">{isAdmin ? "yes" : "no"}</span>
            <span data-testid="pending">{isPending ? "yes" : "no"}</span>
            <span data-testid="name">{user.name}</span>
        </div>
    );
}

const initialAdmin: InitialClientSession = {
    user: { id: "1", name: "Initial Admin", email: "i@a.com", image: null, role: "admin" },
};

function renderWithAuth(sessionData: unknown, initialSession: InitialClientSession = initialAdmin) {
    fakeUseSession.mockReturnValue(sessionData);

    return renderWithProviders(
        <LanguageProvider>
            <AuthProvider initialSession={initialSession}>
                <TestConsumer />
            </AuthProvider>
        </LanguageProvider>
    );
}

describe("AuthProvider", () => {
    test("uses initialSession user while live session is pending", () => {
        fakeRouterRefresh.mockClear();
        renderWithAuth({ data: null, isPending: true, error: null });

        expect(screen.getByTestId("role")).toHaveTextContent("admin");
        expect(screen.getByTestId("admin")).toHaveTextContent("yes");
        expect(screen.getByTestId("pending")).toHaveTextContent("yes");
        expect(screen.getByTestId("name")).toHaveTextContent("Initial Admin");
        expect(fakeRouterRefresh).not.toHaveBeenCalled();
    });

    test("renders children with live session data once resolved", () => {
        fakeRouterRefresh.mockClear();
        renderWithAuth({
            data: {
                user: { id: "2", name: "Live User", email: "l@u.com", role: "manager" },
                session: {},
            },
            isPending: false,
            error: null,
        });

        expect(screen.getByTestId("role")).toHaveTextContent("manager");
        expect(screen.getByTestId("admin")).toHaveTextContent("no");
        expect(screen.getByTestId("pending")).toHaveTextContent("no");
        expect(screen.getByTestId("name")).toHaveTextContent("Live User");
        expect(fakeRouterRefresh).not.toHaveBeenCalled();
    });

    test("renders nothing and calls router.refresh when live session is gone", () => {
        fakeRouterRefresh.mockClear();
        renderWithAuth({ data: null, isPending: false, error: null });

        expect(screen.queryByTestId("role")).not.toBeInTheDocument();
        expect(screen.queryByText("no-user")).not.toBeInTheDocument();
        expect(fakeRouterRefresh).toHaveBeenCalledTimes(1);
    });
});
