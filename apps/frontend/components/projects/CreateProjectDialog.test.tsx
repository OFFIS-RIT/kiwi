import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Group } from "@/types";

const { groups, isAdmin, createProject, toggleGroupExpanded } = vi.hoisted(() => ({
    groups: { value: [] as Group[] },
    isAdmin: { value: false },
    createProject: vi.fn(),
    toggleGroupExpanded: vi.fn(),
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

Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: {
        value: () => false,
    },
    setPointerCapture: {
        value: () => {},
    },
    releasePointerCapture: {
        value: () => {},
    },
    scrollIntoView: {
        value: () => {},
    },
});

vi.mock("@/hooks/use-data", () => ({
    useGroupsWithProjects: () => ({
        data: groups.value,
        isLoading: false,
        error: null,
    }),
}));

vi.mock("@/lib/api/projects", () => ({
    createProject,
    ORGANIZATION_GROUP_ID: "__organization__",
    PERSONAL_GROUP_ID: "__personal__",
}));

vi.mock("@/providers/AuthProvider", () => ({
    useAuth: () => ({
        isAdmin: isAdmin.value,
    }),
}));

vi.mock("@/providers/SidebarExpansionProvider", () => ({
    useSidebarExpansion: () => ({
        expandedGroups: {},
        toggleGroupExpanded,
    }),
}));

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        signOut: vi.fn(),
        useSession: vi.fn(() => ({ data: null, isPending: false })),
    })),
}));

vi.mock("./FileUploader", () => ({
    FileUploader: () => <div>file-uploader</div>,
}));

import { renderWithProviders } from "@/test/test-utils";
import { CreateProjectDialog } from "./CreateProjectDialog";

function team(id: string, name: string, role: Group["role"]): Group {
    return {
        id,
        name,
        role,
        scope: "team",
        projects: [],
    };
}

function organizationGroup(): Group {
    return {
        id: "__organization__",
        name: "Organization",
        role: "member",
        scope: "organization",
        projects: [],
    };
}

async function openGroupSelect() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Wähle eine Gruppe" }));
}

function optionNames() {
    return screen.getAllByRole("option").map((option) => option.textContent?.trim());
}

describe("CreateProjectDialog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isAdmin.value = false;
        groups.value = [];
        createProject.mockResolvedValue({
            graph: { id: "project_1", name: "Neues Projekt" },
            files: [],
            workflowRunId: null,
        });
    });

    test("shows org-wide and team destinations for organization admins", async () => {
        isAdmin.value = true;
        groups.value = [
            team("team_admin", "Team Admin", "admin"),
            team("team_mod", "Team Moderator", "moderator"),
            team("team_member", "Team Member", "member"),
        ];

        renderWithProviders(<CreateProjectDialog open onOpenChange={vi.fn()} />);

        await openGroupSelect();

        expect(optionNames()).toEqual(["Organisation", "Team Admin", "Team Moderator", "Team Member"]);
    });

    test("does not duplicate an existing organization destination", async () => {
        isAdmin.value = true;
        groups.value = [organizationGroup(), team("team_admin", "Team Admin", "admin")];

        renderWithProviders(<CreateProjectDialog open onOpenChange={vi.fn()} />);

        await openGroupSelect();

        expect(optionNames()).toEqual(["Organisation", "Team Admin"]);
    });

    test("shows only team-admin destinations for non-organization admins", async () => {
        groups.value = [
            team("team_admin", "Team Admin", "admin"),
            team("team_mod", "Team Moderator", "moderator"),
            team("team_member", "Team Member", "member"),
        ];

        renderWithProviders(<CreateProjectDialog open onOpenChange={vi.fn()} />);

        await openGroupSelect();

        expect(optionNames()).toEqual(["Team Admin"]);
    });

    test("expands the selected destination after project creation", async () => {
        groups.value = [team("team_admin", "Team Admin", "admin")];

        renderWithProviders(<CreateProjectDialog open onOpenChange={vi.fn()} groupId="team_admin" />);

        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Graphname"), "Neues Projekt");
        await user.click(screen.getByRole("button", { name: "Erstellen" }));

        expect(createProject).toHaveBeenCalledWith(expect.anything(), "team_admin", "Neues Projekt", [], expect.any(Function));
        expect(toggleGroupExpanded).toHaveBeenCalledWith("team_admin");
        expect(toggleGroupExpanded).not.toHaveBeenCalledWith("project_1");
    });
});
