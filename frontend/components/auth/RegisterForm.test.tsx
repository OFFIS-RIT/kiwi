import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: vi
      .fn()
      .mockReturnValue({ data: null, isPending: false, error: null }),
    signUp: {
      email: vi.fn().mockResolvedValue({}),
    },
    signOut: vi.fn(),
    token: vi.fn(),
  },
  getToken: vi.fn().mockResolvedValue("mock-token"),
  clearTokenCache: vi.fn(),
}));

import { RegisterForm } from "./RegisterForm";
import { LanguageProvider } from "@/providers/LanguageProvider";

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
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/e-mail/i)).toBeInTheDocument();
    // Use exact match for "Passwort" label to avoid matching "Passwort bestätigen"
    expect(screen.getByLabelText("Passwort")).toBeInTheDocument();
    expect(screen.getByLabelText(/bestätigen/i)).toBeInTheDocument();
  });

  test("shows error when passwords do not match", async () => {
    renderRegisterForm();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^name$/i), "Test");
    await user.type(screen.getByLabelText(/e-mail/i), "test@test.com");
    await user.type(screen.getByLabelText("Passwort"), "password1");
    await user.type(screen.getByLabelText(/bestätigen/i), "password2");
    await user.click(screen.getByRole("button", { name: /registrieren/i }));
    expect(screen.getByText(/stimmen nicht überein/i)).toBeInTheDocument();
  });

  test("shows error when submitting empty form", async () => {
    renderRegisterForm();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /registrieren/i }));
    expect(screen.getByText(/pflichtfelder/i)).toBeInTheDocument();
  });

  test("has link to login", () => {
    const onSwitch = vi.fn();
    renderRegisterForm(onSwitch);
    expect(screen.getByText(/anmelden/i)).toBeInTheDocument();
  });
});
