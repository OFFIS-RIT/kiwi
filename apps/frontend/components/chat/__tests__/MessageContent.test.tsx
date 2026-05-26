import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/test-utils";
import {
    downloadProjectFile,
    fetchTextUnit,
    getApiAssetUrl,
    getProjectFileUrl,
} from "@/lib/api/projects";
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
        file_name: "document.pdf",
        file_type: "doc",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        preview: { type: "none" },
        created_at: null,
        updated_at: null,
    })),
    getApiAssetUrl: vi.fn((_client: object, path: string) => `/api${path}`),
    getProjectFileUrl: vi.fn(
        (
            _client: object,
            projectId: string,
            fileId: string,
            options?: { fileName?: string | null; page?: number | null }
        ) => {
            const fileNamePath = options?.fileName ? `/${encodeURIComponent(options.fileName)}` : "";
            const url = `/api/graphs/${projectId}/files/${fileId}${fileNamePath}`;
            return options?.page ? `${url}#page=${options.page}` : url;
        }
    ),
}));

vi.mock("@kiwi/auth/client", () => ({
    createKiwiAuthClient: vi.fn(() => ({
        signOut: vi.fn(),
        useSession: vi.fn(() => ({ data: null, isPending: false })),
    })),
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
        vi.mocked(fetchTextUnit).mockClear();
        vi.mocked(getApiAssetUrl).mockClear();
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

    test("uses the same inline badge number for different source ids with the same resolved reference", () => {
        const sameReference = {
            fileId: "file-1",
            fileKey: undefined,
            fileType: "pdf",
            startPage: 1,
            endPage: 7,
        };

        renderMessageContent([
            {
                type: "text",
                text: `First ${citationFence("src-1", sameReference)} second ${citationFence("src-2", sameReference)}`,
            },
        ]);

        expect(screen.getAllByRole("button", { name: "1" })).toHaveLength(2);
        expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: /document.pdf/i })).toHaveLength(1);
    });

    test("combines footer source file citations by overlapping page ranges", async () => {
        const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
        const pdfCitation = (sourceId: string, startPage: number, endPage: number) =>
            citationFence(sourceId, {
                fileId: "file-1",
                fileKey: undefined,
                fileType: "pdf",
                startPage,
                endPage,
            });

        renderMessageContent([
            {
                type: "text",
                text: [
                    `Alpha ${pdfCitation("src-1", 1, 3)}`,
                    `Beta ${pdfCitation("src-2", 2, 2)}`,
                    `Gamma ${pdfCitation("src-3", 1, 4)}`,
                    `Delta ${pdfCitation("src-4", 5, 9)}`,
                ].join(" "),
            },
        ]);

        expect(screen.getAllByRole("button", { name: /document.pdf/i })).toHaveLength(2);
        expect(screen.getByRole("button", { name: /document.pdf 1 - 4/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /document.pdf 5 - 9/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /document.pdf 2/i })).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /document.pdf 1 - 4/i }));
        await userEvent.click(screen.getByRole("button", { name: /document.pdf 5 - 9/i }));

        expect(getProjectFileUrl).toHaveBeenNthCalledWith(1, expect.any(Object), "graph-1", "file-1", {
            fileName: "document.pdf",
            page: 1,
        });
        expect(getProjectFileUrl).toHaveBeenNthCalledWith(2, expect.any(Object), "graph-1", "file-1", {
            fileName: "document.pdf",
            page: 5,
        });
        expect(openMock).toHaveBeenNthCalledWith(
            1,
            "/api/graphs/graph-1/files/file-1/document.pdf#page=1",
            "_blank"
        );
        expect(openMock).toHaveBeenNthCalledWith(
            2,
            "/api/graphs/graph-1/files/file-1/document.pdf#page=5",
            "_blank"
        );
    });

    test("opens old page-less PDF footer citations without a page fragment", async () => {
        const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
        renderMessageContent([
            {
                type: "text",
                text: `Alpha ${citationFence("src-1", {
                    fileId: "file-1",
                    fileKey: undefined,
                    fileType: "pdf",
                })}`,
            },
        ]);

        await userEvent.click(screen.getByRole("button", { name: /^document\.pdf$/i }));

        expect(getProjectFileUrl).toHaveBeenCalledWith(expect.any(Object), "graph-1", "file-1", {
            fileName: "document.pdf",
            page: null,
        });
        expect(openMock).toHaveBeenCalledWith(
            "/api/graphs/graph-1/files/file-1/document.pdf",
            "_blank"
        );
        expect(downloadProjectFile).not.toHaveBeenCalled();
    });

    test("shows text unit markdown for old page-less PDF inline citations", async () => {
        vi.mocked(fetchTextUnit).mockResolvedValueOnce({
            id: "unit-1",
            project_file_id: "file-1",
            text: "Legacy markdown **evidence**",
            start_page: null,
            end_page: null,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            preview: { type: "none" },
            created_at: null,
            updated_at: null,
        });
        renderMessageContent([
            {
                type: "text",
                text: `Alpha ${citationFence("src-1", {
                    fileId: "file-1",
                    fileKey: undefined,
                    fileType: "pdf",
                })}`,
            },
        ]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByText("Legacy markdown **evidence**")).toBeInTheDocument();
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    test("hides unresolved citation fences", () => {
        const { container } = renderMessageContent([
            { type: "text", text: 'Alpha :::{"type":"cite","id":"src-missing"}::: Omega' },
        ]);

        expect(container.textContent).toContain("Alpha");
        expect(container.textContent).toContain("Omega");
        expect(container.textContent).not.toContain(":::");
        expect(container.textContent).not.toContain("src-missing");
        expect(screen.queryByRole("button", { name: "1" })).not.toBeInTheDocument();
    });

    test("hides malformed citation fences", () => {
        const { container } = renderMessageContent([
            { type: "text", text: 'Alpha :::{ type: "cite", "id": <id> }::: Omega' },
        ]);

        expect(container.textContent).toContain("Alpha");
        expect(container.textContent).toContain("Omega");
        expect(container.textContent).not.toContain(":::");
        expect(container.textContent).not.toContain("<id>");
        expect(screen.queryByRole("button", { name: "1" })).not.toBeInTheDocument();
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

    test("renders PDF page previews in the inline citation dialog without extracted text", async () => {
        vi.mocked(fetchTextUnit).mockResolvedValueOnce({
            id: "unit-1",
            project_file_id: "file-1",
            text: "Alpha evidence",
            start_page: 3,
            end_page: 4,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            preview: {
                type: "pdf_pages",
                start_page: 3,
                end_page: 4,
                pages: [
                    { page: 3, image_path: "/graphs/graph-1/units/unit-1/pages/3.png" },
                    { page: 4, image_path: "/graphs/graph-1/units/unit-1/pages/4.png" },
                ],
            },
            created_at: null,
            updated_at: null,
        });

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByRole("img", { name: "document.pdf page 3" })).toHaveAttribute(
            "src",
            "/api/graphs/graph-1/units/unit-1/pages/3.png"
        );
        expect(screen.getByRole("img", { name: "document.pdf page 4" })).toBeInTheDocument();
        expect(screen.queryByText("Alpha evidence")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
        expect(document.querySelector("[data-slot='dialog-content']")).toHaveClass(
            "flex",
            "h-[80vh]",
            "overflow-hidden"
        );
        const scrollArea = document.querySelector("[data-slot='scroll-area']");
        expect(scrollArea?.parentElement).toHaveClass("min-h-0", "flex-1");
        expect(scrollArea).toHaveClass("h-full");
    });

    test("opens end source file buttons through the file proxy for page-aware PDFs", async () => {
        const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
        renderMessageContent([
            {
                type: "text",
                text: `Alpha ${citationFence("src-1", {
                    fileId: "file-1",
                    fileKey: undefined,
                    fileType: "pdf",
                    startPage: 3,
                    endPage: 4,
                })}`,
            },
        ]);

        await userEvent.click(screen.getByRole("button", { name: /document.pdf/i }));

        expect(getProjectFileUrl).toHaveBeenCalledWith(expect.any(Object), "graph-1", "file-1", {
            fileName: "document.pdf",
            page: 3,
        });
        expect(openMock).toHaveBeenCalledWith(
            "/api/graphs/graph-1/files/file-1/document.pdf#page=3",
            "_blank"
        );
        expect(downloadProjectFile).not.toHaveBeenCalled();
    });

    test("opens dialog source file buttons through the page-aware file proxy", async () => {
        const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
        renderMessageContent([
            {
                type: "text",
                text: `Alpha ${citationFence("src-1", {
                    fileId: "file-1",
                    fileKey: undefined,
                    fileType: "pdf",
                    startPage: 3,
                    endPage: 4,
                })}`,
            },
        ]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));
        const dialog = await screen.findByRole("dialog");
        await userEvent.click(within(dialog).getByRole("button", { name: /document.pdf/i }));

        expect(getProjectFileUrl).toHaveBeenCalledWith(expect.any(Object), "graph-1", "file-1", {
            fileName: "document.pdf",
            page: 3,
        });
        expect(openMock).toHaveBeenCalledWith(
            "/api/graphs/graph-1/files/file-1/document.pdf#page=3",
            "_blank"
        );
        expect(downloadProjectFile).not.toHaveBeenCalled();
    });

    test("keeps legacy file-key fallback for source files without file ids", async () => {
        const openMock = vi.spyOn(window, "open").mockImplementation(() => null);
        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")}` }]);

        await userEvent.click(screen.getByRole("button", { name: /document.pdf/i }));

        expect(downloadProjectFile).toHaveBeenCalledWith(expect.any(Object), "graph-1", "graphs/g1/document.pdf");
        expect(openMock).toHaveBeenCalledWith("https://example.com/download", "_blank");
        expect(getProjectFileUrl).not.toHaveBeenCalled();
    });
});
