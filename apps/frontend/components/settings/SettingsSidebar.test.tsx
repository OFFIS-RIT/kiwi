import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { isAdmin, isSystemAdmin, isAuthPending, canManageSuggestions, canManagePrompts, setActiveSection, push } =
    vi.hoisted(() => ({
        isAdmin: { value: false },
        isSystemAdmin: { value: false },
        isAuthPending: { value: false },
        canManageSuggestions: { value: false },
        canManagePrompts: { value: false },
        setActiveSection: vi.fn(),
        push: vi.fn(),
    }));

vi.mock("@/providers/AuthProvider", () => ({
    useAuth: () => ({ isAdmin: isAdmin.value, isSystemAdmin: isSystemAdmin.value, isPending: isAuthPending.value }),
}));

vi.mock("@/hooks/use-suggestion-access", () => ({
    useCanManageSuggestions: () => ({ canManageSuggestions: canManageSuggestions.value, isLoading: false }),
}));

vi.mock("@/hooks/use-prompt-access", () => ({
    useCanManagePrompts: () => ({ canManagePrompts: canManagePrompts.value, isLoading: false }),
}));

vi.mock("@/providers/SettingsProvider", () => ({
    useSettings: () => ({ activeSection: "appearance", setActiveSection }),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
}));

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        signOut: vi.fn(),
        useSession: vi.fn(() => ({ data: null, isPending: false })),
    })),
}));

import { SidebarProvider } from "@/components/ui/sidebar";
import { renderWithProviders } from "@/test/test-utils";
import { SettingsSidebar } from "./SettingsSidebar";

const renderSidebar = (options?: Parameters<typeof renderWithProviders>[1]) =>
    renderWithProviders(
        <SidebarProvider>
            <SettingsSidebar />
        </SidebarProvider>,
        options
    );

describe("SettingsSidebar", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isAdmin.value = false;
        isSystemAdmin.value = false;
        isAuthPending.value = false;
        canManageSuggestions.value = false;
        canManagePrompts.value = false;
    });

    test("shows General Sections and the Back to app action for a regular credentials user", () => {
        renderSidebar();

        expect(screen.getByText("Zurück zur App")).toBeInTheDocument();
        expect(screen.getByText("Allgemein")).toBeInTheDocument();
        expect(screen.getByText("Konto")).toBeInTheDocument();
        expect(screen.getByText("Darstellung")).toBeInTheDocument();
        expect(screen.getByText("API-Schlüssel")).toBeInTheDocument();
        expect(screen.getByText("Archivierte Chats")).toBeInTheDocument();
    });

    test("hides the System Admin Category for non-system-admins", () => {
        renderSidebar();

        expect(screen.queryByText("System-Admin")).not.toBeInTheDocument();
        expect(screen.queryByText("Benutzerverwaltung")).not.toBeInTheDocument();
    });

    test("shows the System Admin Category with User Management for system admins", () => {
        isAdmin.value = true;
        isSystemAdmin.value = true;

        renderSidebar();

        expect(screen.getByText("System-Admin")).toBeInTheDocument();
        expect(screen.getByText("Benutzerverwaltung")).toBeInTheDocument();
    });

    test("shows System Configuration for organization admins in Administration", () => {
        isAdmin.value = true;

        renderSidebar();

        expect(screen.getByText("Administration")).toBeInTheDocument();
        expect(screen.queryByText("System-Admin")).not.toBeInTheDocument();
        expect(screen.getByText("Systemkonfiguration")).toBeInTheDocument();
    });

    test("waits for auth roles before rendering admin-dependent sections", () => {
        isAdmin.value = false;
        isAuthPending.value = true;

        renderSidebar();

        expect(screen.getByRole("status", { name: "Wird geladen..." })).toBeInTheDocument();
        expect(screen.queryByText("Administration")).not.toBeInTheDocument();
        expect(screen.queryByText("Systemkonfiguration")).not.toBeInTheDocument();
    });

    test("hides the Administration Category without suggestion management rights", () => {
        renderSidebar();

        expect(screen.queryByText("Administration")).not.toBeInTheDocument();
        expect(screen.queryByText("Vorschläge")).not.toBeInTheDocument();
    });

    test("shows the Administration Category with Suggestions for suggestion managers", () => {
        canManageSuggestions.value = true;

        renderSidebar();

        expect(screen.getByText("Administration")).toBeInTheDocument();
        expect(screen.getByText("Vorschläge")).toBeInTheDocument();
    });

    test("hides the Account Section in LDAP mode", () => {
        renderSidebar({ config: { authMode: "ldap" } });

        expect(screen.queryByText("Konto")).not.toBeInTheDocument();
        expect(screen.getByText("Darstellung")).toBeInTheDocument();
    });

    test("selecting a Section updates the active section", async () => {
        const user = userEvent.setup();
        renderSidebar();

        await user.click(screen.getByText("API-Schlüssel"));

        expect(setActiveSection).toHaveBeenCalledWith("api-keys");
    });
});
