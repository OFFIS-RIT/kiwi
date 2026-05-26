import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { fetchGroupUsers, fetchGroupAvailableUsers, updateGroupUsers, isAdmin } = vi.hoisted(() => ({
    fetchGroupUsers: vi.fn(),
    fetchGroupAvailableUsers: vi.fn(),
    updateGroupUsers: vi.fn(),
    isAdmin: { value: true },
}));

class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    value: ResizeObserverMock,
});

vi.mock("@/lib/api/groups", () => ({
    fetchGroupUsers,
    fetchGroupAvailableUsers,
    updateGroup: vi.fn(),
    updateGroupUsers,
}));

vi.mock("@/providers/AuthProvider", () => ({
    useAuth: () => ({
        isAdmin: isAdmin.value,
    }),
}));

import { renderWithProviders } from "@/test/test-utils";
import { EditGroupDialog } from "./EditGroupDialog";

function renderDialog(ui: ReactElement) {
    return renderWithProviders(ui);
}

describe("EditGroupDialog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isAdmin.value = true;
        fetchGroupUsers.mockResolvedValue([]);
        fetchGroupAvailableUsers.mockResolvedValue([]);
        updateGroupUsers.mockResolvedValue([]);
    });

    test("shows fetched user names in the group member list", async () => {
        fetchGroupUsers.mockResolvedValue([
            {
                team_id: "group_1",
                user_id: "user_1",
                user_name: "Max Mustermann",
                role: "admin",
                created_at: null,
                updated_at: null,
            },
        ]);

        renderDialog(
            <EditGroupDialog
                open
                onOpenChange={vi.fn()}
                group={{
                    id: "group_1",
                    name: "Team Wissen",
                    role: "admin",
                    scope: "team",
                    projects: [],
                }}
            />
        );

        await waitFor(() => expect(fetchGroupUsers).toHaveBeenCalledWith(expect.anything(), "group_1"));
        expect(await screen.findByText("Max Mustermann")).toBeInTheDocument();
        expect(screen.getByText("MM")).toBeInTheDocument();
        expect(screen.queryByText("user.id: user_1")).not.toBeInTheDocument();
    });

    test("suggests matching user names when adding a group member", async () => {
        fetchGroupAvailableUsers.mockResolvedValue([
            {
                user_id: "user_2",
                user_name: "Anna Example",
                user_email: "anna@example.com",
                role: "member",
            },
        ]);

        renderDialog(
            <EditGroupDialog
                open
                onOpenChange={vi.fn()}
                group={{
                    id: "group_1",
                    name: "Team Wissen",
                    role: "admin",
                    scope: "team",
                    projects: [],
                }}
            />
        );

        await waitFor(() => expect(fetchGroupAvailableUsers).toHaveBeenCalledWith(expect.anything(), "group_1"));

        const user = userEvent.setup();
        await user.type(await screen.findByPlaceholderText("Benutzer suchen..."), "Anna");

        await user.click(await screen.findByRole("button", { name: /Anna Example/i }));

        expect(screen.getByDisplayValue("Anna Example")).toBeInTheDocument();
        expect(screen.getByText("AE")).toBeInTheDocument();
    });

    test("matches names case-insensitively with hyphens, omitted middle names, and small typos", async () => {
        fetchGroupAvailableUsers.mockResolvedValue([
            {
                user_id: "user_3",
                user_name: "Anna-Maria Meier",
                user_email: "anna.maria@example.com",
                role: "member",
            },
        ]);

        renderDialog(
            <EditGroupDialog
                open
                onOpenChange={vi.fn()}
                group={{
                    id: "group_1",
                    name: "Team Wissen",
                    role: "admin",
                    scope: "team",
                    projects: [],
                }}
            />
        );

        const user = userEvent.setup();
        await user.type(await screen.findByPlaceholderText("Benutzer suchen..."), "ANNA MEIR");

        await waitFor(() => expect(fetchGroupAvailableUsers).toHaveBeenCalledWith(expect.anything(), "group_1"));

        expect(await screen.findByRole("button", { name: /Anna-Maria Meier/i })).toBeInTheDocument();
    });

    test("filters locally without refetching on every keystroke", async () => {
        fetchGroupAvailableUsers.mockResolvedValue([
            {
                user_id: "user_2",
                user_name: "Anna Example",
                user_email: "anna@example.com",
                role: "member",
            },
        ]);

        renderDialog(
            <EditGroupDialog
                open
                onOpenChange={vi.fn()}
                group={{
                    id: "group_1",
                    name: "Team Wissen",
                    role: "admin",
                    scope: "team",
                    projects: [],
                }}
            />
        );

        await waitFor(() => expect(fetchGroupAvailableUsers).toHaveBeenCalledWith(expect.anything(), "group_1"));

        const user = userEvent.setup();
        await user.type(await screen.findByPlaceholderText("Benutzer suchen..."), "Ann");

        expect(fetchGroupAvailableUsers).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole("button", { name: /Anna Example/i })).toBeInTheDocument();
    });
});
