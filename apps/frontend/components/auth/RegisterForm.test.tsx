import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

vi.mock("@kiwi/auth/client", () => ({
    authClient: {
        useSession: vi.fn().mockReturnValue({ data: null, isPending: false, error: null }),
        signUp: {
            email: vi.fn().mockResolvedValue({}),
        },
        signOut: vi.fn(),
    },
}));

import { LanguageProvider } from "@/providers/LanguageProvider";
import { RegisterForm } from "./RegisterForm";

function renderRegisterForm(onSwitch = vi.fn()) {
    return render(
        <LanguageProvider>
            <RegisterForm onSwitchToLogin={onSwitch} />
        </LanguageProvider>
    );
}

describe("RegisterForm", () => {
    test("renders all registration fields", () => {
        renderRegisterForm();
        expect(document.getElementById("name")).toBeInTheDocument();
        expect(document.getElementById("email")).toBeInTheDocument();
        expect(document.getElementById("password")).toBeInTheDocument();
        expect(document.getElementById("confirmPassword")).toBeInTheDocument();
    });

    test("shows error when passwords do not match", async () => {
        renderRegisterForm();
        const user = userEvent.setup();
        await user.type(document.getElementById("name")!, "Test");
        await user.type(document.getElementById("email")!, "test@test.com");
        await user.type(document.getElementById("password")!, "password1");
        await user.type(document.getElementById("confirmPassword")!, "password2");
        await user.click(screen.getByRole("button", { name: /sign.up|registrier/i }));
        expect(document.querySelector(".text-destructive")).toBeInTheDocument();
    });

    test("shows error when submitting empty form", async () => {
        renderRegisterForm();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /sign.up|registrier/i }));
        expect(document.querySelector(".text-destructive")).toBeInTheDocument();
    });

    test("has link to login", () => {
        const onSwitch = vi.fn();
        renderRegisterForm(onSwitch);
        const buttons = screen.getAllByRole("button");
        expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
});
