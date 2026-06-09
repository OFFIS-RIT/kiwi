import { screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    value: ResizeObserverMock,
});

vi.mock("@/hooks/use-data", () => ({
    useGroupsWithProjects: () => ({
        data: [
            {
                id: "group_1",
                name: "Team Wissen",
                role: "admin",
                scope: "team",
                projects: [],
            },
        ],
    }),
    useProjectFiles: () => ({
        data: [
            {
                id: "file_1",
                file_key: "file_1",
                name: "README.pdf",
                status: "processed",
                process_step: "completed",
                process_error_code: null,
                created_at: "2026-04-17T10:00:00.000Z",
                updated_at: "2026-04-17T10:00:00.000Z",
            },
        ],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
    }),
    useRetryProjectFile: () => ({
        mutate: vi.fn(),
        isPending: false,
    }),
}));

vi.mock("@/lib/api/projects", () => ({
    addFilesToProject: vi.fn(),
    deleteProjectFiles: vi.fn(),
    updateProject: vi.fn(),
}));

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        signOut: vi.fn(),
        useSession: vi.fn(() => ({ data: null, isPending: false })),
    })),
}));

vi.mock("@/providers/AuthProvider", () => ({
    useAuth: () => ({
        isAdmin: false,
    }),
}));

vi.mock("./FileUploader", () => ({
    FileUploader: () => <div>file-uploader</div>,
}));

vi.mock("./FileStatusIcon", () => ({
    FileStatusIcon: () => <div>status-icon</div>,
}));

import { renderWithProviders } from "@/test/test-utils";
import { EditProjectDialog } from "./EditProjectDialog";

describe("EditProjectDialog", () => {
    test("renders name field and project files inside the dialog scroll area", () => {
        renderWithProviders(
            <EditProjectDialog
                open
                onOpenChange={vi.fn()}
                project={{
                    id: "project_1",
                    name: "Wissensbasis",
                }}
                groupId="group_1"
            />
        );

        const nameInput = screen.getByLabelText("Projektname");
        const fileName = screen.getByText("README.pdf");
        const scrollArea = fileName.closest('[data-slot="scroll-area"]');

        expect(scrollArea).not.toBeNull();
        expect(scrollArea?.contains(nameInput)).toBe(true);
    });
});
