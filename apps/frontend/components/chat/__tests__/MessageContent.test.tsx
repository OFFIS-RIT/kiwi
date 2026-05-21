import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/test-utils";
import { downloadProjectFile, getProjectFileUrl } from "@/lib/api/projects";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { MessageContent } from "../MessageContent";

vi.mock("@/lib/api/projects", () => ({
    downloadProjectFile: vi.fn(async () => "https://example.com/download"),
    fetchTextUnit: vi.fn(async () => ({
        id: "unit-1",
        project_file_id: "file-1",
        text: "Alpha evidence",
        start_page: 3,
        end_page: 4,
        created_at: null,
        updated_at: null,
    })),
    getProjectFileUrl: vi.fn((projectId: string, fileId: string, options?: { page?: number | null }) => {
        const url = `/api/graphs/${projectId}/files/${fileId}`;
        return options?.page ? `${url}?page=${options.page}#page=${options.page}` : url;
    }),
}));

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        signOut: vi.fn(),
        useSession: vi.fn(() => ({ data: null, isPending: false })),
    })),
}));

function citationFence(sourceId: string, fields: Record<string, unknown> = {}) {
    return `:::${JSON.stringify({
        type: "cite",
        sourceId,
        unitId: "unit-1",
        fileName: "document.pdf",
        fileKey: "graphs/g1/document.pdf",
        ...fields,
    })}:::`;
}

function renderMessageContent(parts: ChatUIMessage["parts"]) {
    localStorage.setItem("language", "en");

    return renderWithProviders(<MessageContent parts={parts} projectId="graph-1" />);
}

describe("MessageContent", () => {
    beforeEach(() => {
        vi.mocked(downloadProjectFile).mockClear();
        vi.mocked(getProjectFileUrl).mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test("renders inline citation badges and source file footer", () => {
        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        expect(screen.getByText(/Alpha/)).toBeInTheDocument();
        expect(screen.getByText(/Omega/)).toBeInTheDocument();
        expect(screen.getByText("1")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /document.pdf/i })).toBeInTheDocument();
    });

    test("deduplicates source files while preserving repeated citation badges", () => {
        renderMessageContent([
            {
                type: "text",
                text: `First ${citationFence("src-1")} then again ${citationFence("src-1")}`,
            },
        ]);

        expect(screen.getAllByText("1")).toHaveLength(2);
        expect(screen.getAllByRole("button", { name: /document.pdf/i })).toHaveLength(1);
    });

    test("keeps text reference dialog open across parent rerenders", async () => {
        const parts: ChatUIMessage["parts"] = [{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }];
        localStorage.setItem("language", "en");

        const { rerender } = renderWithProviders(<MessageContent parts={parts} projectId="graph-1" />);

        await userEvent.click(screen.getByRole("button", { name: "1" }));
        expect(await screen.findByText("Alpha evidence")).toBeInTheDocument();

        rerender(<MessageContent parts={parts} projectId="graph-1" />);

        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Alpha evidence")).toBeInTheDocument();
    });

    test("opens end source file buttons through the file proxy for page-aware PDFs", async () => {
        const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
        renderMessageContent([
            {
                type: "text",
                text: `Alpha ${citationFence("src-1", {
                    fileId: "file-1",
                    fileType: "pdf",
                    startPage: 3,
                    endPage: 4,
                })}`,
            },
        ]);

        await userEvent.click(screen.getByRole("button", { name: /document.pdf/i }));

        expect(getProjectFileUrl).toHaveBeenCalledWith("graph-1", "file-1", { page: 3 });
        expect(openMock).toHaveBeenCalledWith("/api/graphs/graph-1/files/file-1?page=3#page=3", "_blank");
        expect(downloadProjectFile).not.toHaveBeenCalled();
    });

    test("keeps legacy presigned URL fallback for source files without file ids", async () => {
        const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")}` }]);

        await userEvent.click(screen.getByRole("button", { name: /document.pdf/i }));

        expect(downloadProjectFile).toHaveBeenCalledWith(expect.any(Object), "graph-1", "graphs/g1/document.pdf");
        expect(openMock).toHaveBeenCalledWith("https://example.com/download", "_blank");
        expect(getProjectFileUrl).not.toHaveBeenCalled();
    });
});
