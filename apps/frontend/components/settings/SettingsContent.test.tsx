import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
    activeSection,
    authMode,
    canManagePrompts,
    canManageSuggestions,
    isAdmin,
    isAuthPending,
    isPromptAccessLoading,
    isSuggestionAccessLoading,
    isSystemAdmin,
    resolveActiveSettingsSectionMock,
} = vi.hoisted(() => ({
    activeSection: { value: "appearance" },
    authMode: { value: "credentials" },
    canManagePrompts: { value: false },
    canManageSuggestions: { value: false },
    isAdmin: { value: false },
    isAuthPending: { value: false },
    isPromptAccessLoading: { value: false },
    isSuggestionAccessLoading: { value: false },
    isSystemAdmin: { value: false },
    resolveActiveSettingsSectionMock: vi.fn(),
}));

vi.mock("@/providers/AuthProvider", () => ({
    useAuth: () => ({
        isAdmin: isAdmin.value,
        isPending: isAuthPending.value,
        isSystemAdmin: isSystemAdmin.value,
    }),
}));

vi.mock("@/providers/RuntimeConfigProvider", () => ({
    useRuntimeConfig: () => ({ authMode: authMode.value }),
}));

vi.mock("@/providers/SettingsProvider", () => ({
    useSettings: () => ({ activeSection: activeSection.value }),
}));

vi.mock("@/hooks/use-suggestion-access", () => ({
    useCanManageSuggestions: () => ({
        canManageSuggestions: canManageSuggestions.value,
        isLoading: isSuggestionAccessLoading.value,
    }),
}));

vi.mock("@/hooks/use-prompt-access", () => ({
    useCanManagePrompts: () => ({
        canManagePrompts: canManagePrompts.value,
        isLoading: isPromptAccessLoading.value,
    }),
}));

vi.mock("./sections", () => ({
    resolveActiveSettingsSection: resolveActiveSettingsSectionMock,
}));

import { SettingsContent } from "./SettingsContent";

describe("SettingsContent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        activeSection.value = "appearance";
        authMode.value = "credentials";
        canManagePrompts.value = false;
        canManageSuggestions.value = false;
        isAdmin.value = false;
        isAuthPending.value = false;
        isPromptAccessLoading.value = false;
        isSuggestionAccessLoading.value = false;
        isSystemAdmin.value = false;
        resolveActiveSettingsSectionMock.mockReturnValue({ Component: () => "Resolved Section" });
    });

    test("waits for auth roles before resolving a System Configuration deep link", () => {
        activeSection.value = "system-configuration";
        isAuthPending.value = true;

        const { container } = render(<SettingsContent />);

        expect(resolveActiveSettingsSectionMock).not.toHaveBeenCalled();
        expect(screen.queryByText("Resolved Section")).not.toBeInTheDocument();
        expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    });

    test("resolves System Configuration after auth roles are known", () => {
        activeSection.value = "system-configuration";
        isAdmin.value = true;

        render(<SettingsContent />);

        expect(resolveActiveSettingsSectionMock).toHaveBeenCalledWith("system-configuration", {
            authMode: "credentials",
            canManagePrompts: false,
            canManageSuggestions: false,
            isAdmin: true,
            isSystemAdmin: false,
        });
        expect(screen.getByText("Resolved Section")).toBeInTheDocument();
    });
});
