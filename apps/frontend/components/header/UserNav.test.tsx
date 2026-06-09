import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { organizations, signOut } = vi.hoisted(() => ({
    organizations: { value: [] as Array<{ id: string; name: string }> },
    signOut: vi.fn(),
}));

Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { value: () => false },
    setPointerCapture: { value: () => {} },
    releasePointerCapture: { value: () => {} },
    scrollIntoView: { value: () => {} },
});

vi.mock("@/providers/AuthProvider", () => ({
    useAuth: () => ({ user: { id: "u1", name: "Test User", email: "test@example.com", role: "user" }, signOut }),
}));

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        useSession: vi.fn(() => ({ data: null, isPending: false })),
        useListOrganizations: () => ({ data: organizations.value }),
        useActiveOrganization: () => ({ data: organizations.value[0] ?? null }),
        organization: { setActive: vi.fn(async () => ({ error: null })) },
        signOut,
    })),
}));

import { renderWithProviders } from "@/test/test-utils";
import { UserNav } from "./UserNav";

async function openMenu() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));
    return user;
}

describe("UserNav", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        organizations.value = [];
    });

    test("offers only Settings and Sign Out (no theme, admin, or API key entries)", async () => {
        renderWithProviders(<UserNav />);
        await openMenu();

        expect(screen.getByText("Einstellungen")).toBeInTheDocument();
        expect(screen.getByText("Abmelden")).toBeInTheDocument();

        expect(screen.queryByText("Design")).not.toBeInTheDocument();
        expect(screen.queryByText("API-Schlüssel")).not.toBeInTheDocument();
        expect(screen.queryByText("Admin")).not.toBeInTheDocument();
    });

    test("hides the organization switcher when the user has a single organization", async () => {
        organizations.value = [{ id: "org1", name: "Org One" }];
        renderWithProviders(<UserNav />);
        await openMenu();

        expect(screen.queryByText("organization.switch")).not.toBeInTheDocument();
    });

    test("shows the organization switcher when the user has multiple organizations", async () => {
        organizations.value = [
            { id: "org1", name: "Org One" },
            { id: "org2", name: "Org Two" },
        ];
        renderWithProviders(<UserNav />);
        await openMenu();

        expect(screen.getByText("organization.switch")).toBeInTheDocument();
    });

    test("signs out when the Sign Out item is selected", async () => {
        renderWithProviders(<UserNav />);
        const user = await openMenu();

        await user.click(screen.getByText("Abmelden"));

        expect(signOut).toHaveBeenCalled();
    });
});
