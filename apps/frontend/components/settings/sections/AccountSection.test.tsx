import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { currentUser, updateUser, changeEmail, changePassword, toastError, refresh } = vi.hoisted(() => ({
    currentUser: { id: "u1", name: "Test User", email: "test@example.com", role: "user" },
    updateUser: vi.fn(async () => ({ error: null })),
    changeEmail: vi.fn(
        async (): Promise<{ error: null | { message?: string; status?: number; code?: string } }> => ({ error: null })
    ),
    changePassword: vi.fn(async () => ({ error: null })),
    toastError: vi.fn(),
    refresh: vi.fn(),
}));

vi.mock("@/providers/AuthProvider", () => ({
    // Stable user reference so the field-syncing effect does not reset inputs on re-render.
    useAuth: () => ({ user: currentUser }),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh }),
}));

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: toastError },
}));

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        useSession: vi.fn(() => ({ data: null, isPending: false })),
        updateUser,
        changeEmail,
        changePassword,
    })),
}));

import { renderWithProviders } from "@/test/test-utils";
import { AccountSection } from "./AccountSection";

describe("AccountSection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test("updates the display name via updateUser without touching the email", async () => {
        const user = userEvent.setup();
        renderWithProviders(<AccountSection />);

        const nameInput = screen.getByLabelText("Name");
        await user.clear(nameInput);
        await user.type(nameInput, "New Name");

        const saveButtons = screen.getAllByRole("button", { name: "Änderungen speichern" });
        await user.click(saveButtons[0]);

        expect(updateUser).toHaveBeenCalledWith({ name: "New Name" });
        expect(changeEmail).not.toHaveBeenCalled();
    });

    test("updates only the email via changeEmail when only the email changed", async () => {
        const user = userEvent.setup();
        renderWithProviders(<AccountSection />);

        const emailInput = screen.getByLabelText("E-Mail");
        await user.clear(emailInput);
        await user.type(emailInput, "new@example.com");

        const saveButtons = screen.getAllByRole("button", { name: "Änderungen speichern" });
        await user.click(saveButtons[0]);

        expect(changeEmail).toHaveBeenCalledWith({ newEmail: "new@example.com" });
        expect(updateUser).not.toHaveBeenCalled();
    });

    test("on a partial profile failure (name ok, email fails) it still refreshes and reports the error", async () => {
        changeEmail.mockResolvedValueOnce({ error: { message: "boom" } });
        const user = userEvent.setup();
        renderWithProviders(<AccountSection />);

        const nameInput = screen.getByLabelText("Name");
        await user.clear(nameInput);
        await user.type(nameInput, "New Name");
        const emailInput = screen.getByLabelText("E-Mail");
        await user.clear(emailInput);
        await user.type(emailInput, "new@example.com");

        const saveButtons = screen.getAllByRole("button", { name: "Änderungen speichern" });
        await user.click(saveButtons[0]);

        expect(updateUser).toHaveBeenCalledWith({ name: "New Name" });
        expect(changeEmail).toHaveBeenCalledWith({ newEmail: "new@example.com" });
        expect(refresh).toHaveBeenCalled();
        expect(toastError).toHaveBeenCalled();
    });

    test("shows an 'already registered' message when the email change conflicts", async () => {
        changeEmail.mockResolvedValueOnce({ error: { status: 409, message: "email exists" } });
        const user = userEvent.setup();
        renderWithProviders(<AccountSection />);

        const emailInput = screen.getByLabelText("E-Mail");
        await user.clear(emailInput);
        await user.type(emailInput, "taken@example.com");

        const saveButtons = screen.getAllByRole("button", { name: "Änderungen speichern" });
        await user.click(saveButtons[0]);

        expect(toastError).toHaveBeenCalledWith("Diese E-Mail ist bereits registriert.");
    });

    test("treats a non-conflict 422 as a generic email failure, not an 'already registered' conflict", async () => {
        changeEmail.mockResolvedValueOnce({ error: { status: 422, message: "Invalid email format" } });
        const user = userEvent.setup();
        renderWithProviders(<AccountSection />);

        const emailInput = screen.getByLabelText("E-Mail");
        await user.clear(emailInput);
        await user.type(emailInput, "other@example.com");

        const saveButtons = screen.getAllByRole("button", { name: "Änderungen speichern" });
        await user.click(saveButtons[0]);

        expect(toastError).toHaveBeenCalledWith("E-Mail-Adresse konnte nicht aktualisiert werden.");
        expect(toastError).not.toHaveBeenCalledWith("Diese E-Mail ist bereits registriert.");
    });

    test("changes the password via changePassword when both fields match", async () => {
        const user = userEvent.setup();
        renderWithProviders(<AccountSection />);

        await user.type(screen.getByLabelText("Aktuelles Passwort"), "oldpass");
        await user.type(screen.getByLabelText("Neues Passwort"), "newpass123");
        await user.type(screen.getByLabelText("Neues Passwort bestätigen"), "newpass123");

        const saveButtons = screen.getAllByRole("button", { name: "Änderungen speichern" });
        await user.click(saveButtons[1]);

        expect(changePassword).toHaveBeenCalledWith({ currentPassword: "oldpass", newPassword: "newpass123" });
    });

    test("rejects a mismatched password confirmation without calling changePassword", async () => {
        const user = userEvent.setup();
        renderWithProviders(<AccountSection />);

        await user.type(screen.getByLabelText("Aktuelles Passwort"), "oldpass");
        await user.type(screen.getByLabelText("Neues Passwort"), "newpass123");
        await user.type(screen.getByLabelText("Neues Passwort bestätigen"), "different");

        const saveButtons = screen.getAllByRole("button", { name: "Änderungen speichern" });
        await user.click(saveButtons[1]);

        expect(changePassword).not.toHaveBeenCalled();
        expect(toastError).toHaveBeenCalled();
    });
});
