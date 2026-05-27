import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const fakeUseSession = vi.fn();
const fakeUseActiveMemberRole = vi.fn();
const fakeSignOut = vi.fn();

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        useSession: fakeUseSession,
        useActiveMemberRole: fakeUseActiveMemberRole,
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
import { renderWithProviders } from "@/test/test-utils";
import { AuthProvider, useAuth } from "./AuthProvider";

function TestConsumer() {
    const { user, isAdmin, role, isAuthenticated, isPending, isSigningOut, signOut } = useAuth();
    if (!user) {
        return <div>no-user</div>;
    }

    return (
        <div>
            <span data-testid="role">{role}</span>
            <span data-testid="admin">{isAdmin ? "yes" : "no"}</span>
            <span data-testid="authenticated">{isAuthenticated ? "yes" : "no"}</span>
            <span data-testid="pending">{isPending ? "yes" : "no"}</span>
            <span data-testid="signing-out">{isSigningOut ? "yes" : "no"}</span>
            <span data-testid="name">{user.name}</span>
            <button type="button" onClick={() => void signOut()}>
                Sign out
            </button>
        </div>
    );
}

const initialAdmin: InitialClientSession = {
    user: { id: "1", name: "Initial Admin", email: "i@a.com", image: null, role: "admin" },
};

function renderWithAuth(sessionData: unknown, initialSession: InitialClientSession = initialAdmin, activeRole = "admin") {
    fakeUseSession.mockReturnValue(sessionData);
    fakeUseActiveMemberRole.mockReturnValue({
        data: { role: activeRole },
        isPending: false,
        error: null,
    });

    return renderWithProviders(
        <AuthProvider initialSession={initialSession}>
            <TestConsumer />
        </AuthProvider>
    );
}

describe("AuthProvider", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test("uses initialSession user while live session is pending", () => {
        renderWithAuth({ data: null, isPending: true, error: null });

        expect(screen.getByTestId("role")).toHaveTextContent("admin");
        expect(screen.getByTestId("admin")).toHaveTextContent("yes");
        expect(screen.getByTestId("authenticated")).toHaveTextContent("yes");
        expect(screen.getByTestId("pending")).toHaveTextContent("yes");
        expect(screen.getByTestId("name")).toHaveTextContent("Initial Admin");
        expect(fakeRouterRefresh).not.toHaveBeenCalled();
    });

    test("renders children with live session data once resolved", () => {
        renderWithAuth({
            data: {
                user: { id: "2", name: "Live User", email: "l@u.com", role: "user" },
                session: {},
            },
            isPending: false,
            error: null,
        });

        expect(screen.getByTestId("role")).toHaveTextContent("admin");
        expect(screen.getByTestId("admin")).toHaveTextContent("yes");
        expect(screen.getByTestId("authenticated")).toHaveTextContent("yes");
        expect(screen.getByTestId("pending")).toHaveTextContent("no");
        expect(screen.getByTestId("name")).toHaveTextContent("Live User");
        expect(fakeRouterRefresh).not.toHaveBeenCalled();
    });

    test("clears the client user and calls router.refresh when live session is gone", () => {
        renderWithAuth({ data: null, isPending: false, error: null });

        expect(screen.getByText("no-user")).toBeInTheDocument();
        expect(fakeRouterRefresh).toHaveBeenCalledTimes(1);
    });

    test("enters signing-out state before calling Better Auth signOut", async () => {
        fakeSignOut.mockResolvedValueOnce({});
        renderWithAuth({
            data: {
                user: { id: "2", name: "Live User", email: "l@u.com", role: "user" },
                session: {},
            },
            isPending: false,
            error: null,
        });

        fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

        await waitFor(() => expect(fakeSignOut).toHaveBeenCalledTimes(1));
        expect(screen.getByText("no-user")).toBeInTheDocument();
        expect(fakeRouterReplace).toHaveBeenCalledWith("/login");
    });

    test("treats system admins as effective organization admins", () => {
        renderWithAuth({ data: null, isPending: true, error: null }, initialAdmin, "member");

        expect(screen.getByTestId("role")).toHaveTextContent("admin");
        expect(screen.getByTestId("admin")).toHaveTextContent("yes");
    });
});
