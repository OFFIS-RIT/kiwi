import { render, screen } from "@testing-library/react";
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
    useProjectFiles: () => ({
        data: [
            {
                id: "file_1",
                file_key: "file_1",
                name: "README.pdf",
                status: "processed",
                created_at: "2026-04-17T10:00:00.000Z",
                updated_at: "2026-04-17T10:00:00.000Z",
            },
        ],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
    }),
}));

vi.mock("@/lib/api/projects", () => ({
    addFilesToProject: vi.fn(),
    deleteProjectFiles: vi.fn(),
    updateProject: vi.fn(),
}));

vi.mock("@/providers/AuthProvider", () => ({
    useAuth: () => ({
        hasPermission: () => false,
    }),
}));

vi.mock("@/providers/DataProvider", () => ({
    useData: () => ({
        refreshData: vi.fn(),
    }),
}));

vi.mock("@/providers/LanguageProvider", () => ({
    useLanguage: () => ({
        t: (key: string) => key,
    }),
}));

vi.mock("./FileUploader", () => ({
    FileUploader: () => <div>file-uploader</div>,
}));

vi.mock("./FileStatusIcon", () => ({
    FileStatusIcon: () => <div>status-icon</div>,
}));

import { EditProjectDialog } from "./EditProjectDialog";

describe("EditProjectDialog", () => {
    test("renders name field and project files inside the dialog scroll area", () => {
        render(
            <EditProjectDialog
                open
                onOpenChange={vi.fn()}
                project={{
                    id: "project_1",
                    name: "Wissensbasis",
                }}
                groupId={null}
            />
        );

        const nameInput = screen.getByLabelText("project.name");
        const fileName = screen.getByText("README.pdf");
        const scrollArea = fileName.closest('[data-slot="scroll-area"]');

        expect(scrollArea).not.toBeNull();
        expect(scrollArea?.contains(nameInput)).toBe(true);
    });
});
