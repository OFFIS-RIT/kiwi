import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { fetchGroupUsers, translate, hasPermission, listUsers } = vi.hoisted(() => ({
    fetchGroupUsers: vi.fn(),
    translate: vi.fn((key: string) => key),
    hasPermission: vi.fn((_: string) => false),
    listUsers: vi.fn(),
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
    updateGroup: vi.fn(),
}));

vi.mock("@kiwi/auth/client", () => ({
    authClient: {
        admin: {
            listUsers,
        },
    },
}));

vi.mock("@/providers/AuthProvider", () => ({
    useAuth: () => ({
        hasPermission,
    }),
}));

vi.mock("@/providers/DataProvider", () => ({
    useData: () => ({
        refreshData: vi.fn(),
    }),
}));

vi.mock("@/providers/LanguageProvider", () => ({
    useLanguage: () => ({
        t: translate,
    }),
}));

import { EditGroupDialog } from "./EditGroupDialog";

describe("EditGroupDialog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hasPermission.mockReturnValue(false);
        translate.mockImplementation((key: string) => key);
        fetchGroupUsers.mockResolvedValue([]);
    });

    test("shows fetched user names in the group member list", async () => {
        fetchGroupUsers.mockResolvedValue([
            {
                group_id: "group_1",
                user_id: "user_1",
                user_name: "Max Mustermann",
                role: "admin",
                created_at: null,
                updated_at: null,
            },
        ]);

        render(
            <EditGroupDialog
                open
                onOpenChange={vi.fn()}
                group={{
                    id: "group_1",
                    name: "Team Wissen",
                }}
            />
        );

        await waitFor(() => expect(fetchGroupUsers).toHaveBeenCalledWith("group_1"));
        expect(await screen.findByText("Max Mustermann")).toBeInTheDocument();
        expect(screen.getByText("MM")).toBeInTheDocument();
        expect(screen.queryByText("user.id: user_1")).not.toBeInTheDocument();
    });

    test("suggests matching user names when adding a group member", async () => {
        hasPermission.mockImplementation((permission: string) => permission === "group.add:user");
        listUsers.mockImplementation(({ query }: { query?: { searchValue?: string } }) => {
            if (query?.searchValue) {
                return Promise.resolve({
                    data: {
                        users: [],
                        total: 0,
                    },
                    error: null,
                });
            }

            return Promise.resolve({
                data: {
                    users: [
                        {
                            id: "user_2",
                            name: "Anna Example",
                            email: "anna@example.com",
                            role: "user",
                            banned: false,
                        },
                    ],
                    total: 1,
                },
                error: null,
            });
        });

        render(
            <EditGroupDialog
                open
                onOpenChange={vi.fn()}
                group={{
                    id: "group_1",
                    name: "Team Wissen",
                }}
            />
        );

        await waitFor(() =>
            expect(listUsers).toHaveBeenCalledWith({
                query: {
                    limit: 100,
                    offset: 0,
                },
            })
        );

        const user = userEvent.setup();
        await user.type(await screen.findByPlaceholderText("admin.search.users"), "Anna");

        await user.click(await screen.findByRole("button", { name: /Anna Example/i }));

        expect(screen.getByDisplayValue("Anna Example")).toBeInTheDocument();
        expect(screen.getByText("AE")).toBeInTheDocument();
    });

    test("matches names case-insensitively with hyphens, omitted middle names, and small typos", async () => {
        hasPermission.mockImplementation((permission: string) => permission === "group.add:user");
        listUsers.mockImplementation(({ query }: { query?: { searchValue?: string } }) => {
            if (query?.searchValue) {
                return Promise.resolve({
                    data: {
                        users: [],
                        total: 0,
                    },
                    error: null,
                });
            }

            return Promise.resolve({
                data: {
                    users: [
                        {
                            id: "user_3",
                            name: "Anna-Maria Meier",
                            email: "anna.maria@example.com",
                            role: "user",
                            banned: false,
                        },
                    ],
                    total: 1,
                },
                error: null,
            });
        });

        render(
            <EditGroupDialog
                open
                onOpenChange={vi.fn()}
                group={{
                    id: "group_1",
                    name: "Team Wissen",
                }}
            />
        );

        const user = userEvent.setup();
        await user.type(await screen.findByPlaceholderText("admin.search.users"), "ANNA MEIR");

        await waitFor(() =>
            expect(listUsers).toHaveBeenCalledWith({
                query: {
                    limit: 100,
                    offset: 0,
                },
            })
        );

        expect(await screen.findByRole("button", { name: /Anna-Maria Meier/i })).toBeInTheDocument();
    });

    test("filters locally without refetching on every keystroke", async () => {
        hasPermission.mockImplementation((permission: string) => permission === "group.add:user");
        listUsers.mockResolvedValue({
            data: {
                users: [
                    {
                        id: "user_2",
                        name: "Anna Example",
                        email: "anna@example.com",
                        role: "user",
                        banned: false,
                    },
                ],
                total: 1,
            },
            error: null,
        });

        render(
            <EditGroupDialog
                open
                onOpenChange={vi.fn()}
                group={{
                    id: "group_1",
                    name: "Team Wissen",
                }}
            />
        );

        await waitFor(() =>
            expect(listUsers).toHaveBeenCalledWith({
                query: {
                    limit: 100,
                    offset: 0,
                },
            })
        );

        const user = userEvent.setup();
        await user.type(await screen.findByPlaceholderText("admin.search.users"), "Ann");

        expect(listUsers).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole("button", { name: /Anna Example/i })).toBeInTheDocument();
    });
});
