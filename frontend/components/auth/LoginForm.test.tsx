import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: vi
      .fn()
      .mockReturnValue({ data: null, isPending: false, error: null }),
    signIn: {
      email: vi.fn().mockResolvedValue({}),
      credentials: vi.fn().mockResolvedValue({}),
    },
    signOut: vi.fn(),
    token: vi.fn(),
  },
  getToken: vi.fn().mockResolvedValue("mock-token"),
  clearTokenCache: vi.fn(),
}));

import { LoginForm } from "./LoginForm";
import { LanguageProvider } from "@/providers/LanguageProvider";

function renderLoginForm(onSwitch = vi.fn()) {
  return render(
    <LanguageProvider>
      <LoginForm onSwitchToRegister={onSwitch} />
    </LanguageProvider>
  );
}

describe("LoginForm", () => {
  test("renders email and password fields in credentials mode", () => {
    renderLoginForm();
    expect(screen.getByLabelText(/e-mail/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/passwort/i)).toBeInTheDocument();
  });

  test("shows error when submitting empty form", async () => {
    renderLoginForm();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /anmelden/i }));
    expect(screen.getByText(/pflichtfelder/i)).toBeInTheDocument();
  });

  test("has link to register", () => {
    const onSwitch = vi.fn();
    renderLoginForm(onSwitch);
    expect(screen.getByText(/registrieren/i)).toBeInTheDocument();
  });
});
