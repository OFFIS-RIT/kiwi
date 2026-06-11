import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/test-utils";
import type { ComponentProps } from "react";
import {
    downloadProjectFile,
    fetchSourceReference,
    fetchSourceReferences,
    getApiAssetUrl,
    getProjectFileUrl,
} from "@/lib/api/projects";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { MessageContent } from "../MessageContent";

vi.mock("@/lib/api/projects", () => {
    const defaultUnit = {
        id: "unit-1",
        project_file_id: "file-1",
        start_page: 3,
        end_page: 4,
        file_name: "document.pdf",
        file_type: "doc",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        created_at: null,
        updated_at: null,
    };
    const defaultTextUnit = {
        ...defaultUnit,
        text: "Alpha evidence",
        preview: { type: "none" as const },
    };

    return {
        downloadProjectFile: vi.fn(async () => "https://example.com/download"),
        fetchSourceReference: vi.fn(async () => ({
            source_id: "src-1",
            description: "Alpha evidence",
            unit: defaultUnit,
            chunks: [{ type: "text" as const, chunk_id: 1, text: "Alpha evidence" }],
            pdf_regions: [],
        })),
        fetchSourceReferences: vi.fn(async (_client: object, _projectId: string, sourceIds: string[]) => ({
            items: [],
            missing_source_ids: sourceIds,
        })),
        fetchTextUnit: vi.fn(async () => defaultTextUnit),
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
    };
});

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

function renderMessageContent(
    parts: ChatUIMessage["parts"],
    props: Partial<ComponentProps<typeof MessageContent>> = {}
) {
    localStorage.setItem("language", "en");

    return renderWithProviders(<MessageContent parts={parts} projectId="graph-1" {...props} />);
}

type MockedFunction<T extends (...args: never[]) => unknown> = T & {
    mockClear: () => void;
    mockRejectedValueOnce: (error: unknown) => void;
    mockResolvedValueOnce: (value: Awaited<ReturnType<T>>) => void;
};

function mocked<T extends (...args: never[]) => unknown>(fn: T): MockedFunction<T> {
    return fn as MockedFunction<T>;
}

function sourceReference(
    unit: Awaited<ReturnType<typeof fetchSourceReference>>["unit"],
    overrides: Partial<Awaited<ReturnType<typeof fetchSourceReference>>> = {}
): Awaited<ReturnType<typeof fetchSourceReference>> {
    return {
        source_id: "src-1",
        description: "Alpha evidence",
        unit,
        chunks: [{ type: "text", chunk_id: 1, text: "Alpha evidence" }],
        pdf_regions: [],
        ...overrides,
    };
}

describe("MessageContent", () => {
    beforeEach(() => {
        mocked(downloadProjectFile).mockClear();
        mocked(fetchSourceReference).mockClear();
        mocked(fetchSourceReferences).mockClear();
        mocked(getApiAssetUrl).mockClear();
        mocked(getProjectFileUrl).mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test("shows a plain thinking label while streaming before visible work starts", () => {
        renderMessageContent([], { isStreaming: true, startedAtMs: Date.now() });

        expect(screen.getByText("Denkt nach...")).toBeInTheDocument();
        expect(screen.queryByText(/Gearbeitet für/)).not.toBeInTheDocument();
    });

    test("shows the worked dropdown once streaming includes a tool call", () => {
        renderMessageContent(
            [
                {
                    type: "tool-search_entities",
                    toolCallId: "tool-1",
                    state: "input-available",
                    input: { query: "PicoScale" },
                },
            ],
            { isStreaming: true, startedAtMs: Date.now() - 2_000 }
        );

        expect(screen.getByRole("button", { name: /Gearbeitet für \d+s/ })).toBeInTheDocument();
        expect(screen.queryByText("Denkt nach...")).not.toBeInTheDocument();
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

    test("collapses directly adjacent duplicate citations into a single badge", () => {
        renderMessageContent([
            {
                type: "text",
                text: `Alpha ${citationFence("src-1")}${citationFence("src-1")} Omega`,
            },
        ]);

        expect(screen.getAllByText("1")).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: /document.pdf/i })).toHaveLength(1);
    });

    test("collapses adjacent duplicate citations separated only by whitespace", () => {
        renderMessageContent([
            {
                type: "text",
                text: `Alpha ${citationFence("src-1")} ${citationFence("src-1")} Omega`,
            },
        ]);

        expect(screen.getAllByText("1")).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: /document.pdf/i })).toHaveLength(1);
    });

    test("collapses adjacent duplicate citations that straddle a text-part boundary", () => {
        renderMessageContent([
            { type: "text", text: `Alpha ${citationFence("src-1")}` },
            { type: "text", text: `${citationFence("src-1")} Omega` },
        ]);

        expect(screen.getAllByText("1")).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: /document.pdf/i })).toHaveLength(1);
    });

    test("collapses adjacent citations from different source ids with the same resolved reference", () => {
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
                text: `Alpha ${citationFence("src-1", sameReference)}${citationFence("src-2", sameReference)} Omega`,
            },
        ]);

        expect(screen.getAllByRole("button", { name: "1" })).toHaveLength(1);
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

    test("opens the clicked source when deduplicated inline badges share a display number", async () => {
        const sameReference = {
            fileId: "file-1",
            fileKey: undefined,
            fileType: "pdf",
            startPage: 1,
            endPage: 7,
        };
        const unit = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: 1,
            end_page: 7,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                source_id: "src-2",
                chunks: [{ type: "text", chunk_id: 2, text: "Second source evidence" }],
            })
        );

        renderMessageContent([
            {
                type: "text",
                text: `First ${citationFence("src-1", sameReference)} second ${citationFence("src-2", sameReference)}`,
            },
        ]);

        await userEvent.click(screen.getAllByRole("button", { name: "1" })[1]!);

        expect(await screen.findByText("Second source evidence")).toBeInTheDocument();
        expect(fetchSourceReference).toHaveBeenCalledWith(expect.any(Object), "graph-1", "src-2");
    });

    test("uses batch-prefetched source references for citation-heavy messages", async () => {
        const firstUnit = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: 1,
            end_page: 1,
            file_name: "first.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        const secondUnit = {
            ...firstUnit,
            id: "unit-2",
            project_file_id: "file-2",
            start_page: 2,
            end_page: 2,
            file_name: "second.pdf",
        };
        mocked(fetchSourceReferences).mockResolvedValueOnce({
            items: [
                sourceReference(firstUnit, {
                    source_id: "src-1",
                    chunks: [{ type: "text", chunk_id: 1, text: "First prefetched evidence" }],
                }),
                sourceReference(secondUnit, {
                    source_id: "src-2",
                    chunks: [{ type: "text", chunk_id: 2, text: "Second prefetched evidence" }],
                }),
            ],
            missing_source_ids: [],
        });

        renderMessageContent([
            {
                type: "text",
                text: `First ${citationFence("src-1", {
                    unitId: "unit-1",
                    fileId: "file-1",
                    fileKey: undefined,
                    fileName: "first.pdf",
                    startPage: 1,
                    endPage: 1,
                })} second ${citationFence("src-2", {
                    unitId: "unit-2",
                    fileId: "file-2",
                    fileKey: undefined,
                    fileName: "second.pdf",
                    startPage: 2,
                    endPage: 2,
                })}`,
            },
        ]);

        await waitFor(() =>
            expect(fetchSourceReferences).toHaveBeenCalledWith(expect.any(Object), "graph-1", ["src-1", "src-2"])
        );
        await userEvent.click(screen.getByRole("button", { name: "2" }));

        expect(await screen.findByText("Second prefetched evidence")).toBeInTheDocument();
        expect(fetchSourceReference).not.toHaveBeenCalled();
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
        expect(screen.getByRole("button", { name: /document\.pdf S\. 1 - 4/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /document\.pdf S\. 5 - 9/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /document\.pdf S\. 2/i })).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /document\.pdf S\. 1 - 4/i }));
        await userEvent.click(screen.getByRole("button", { name: /document\.pdf S\. 5 - 9/i }));

        expect(getProjectFileUrl).toHaveBeenNthCalledWith(1, expect.any(Object), "graph-1", "file-1", {
            fileName: "document.pdf",
            page: 1,
        });
        expect(getProjectFileUrl).toHaveBeenNthCalledWith(2, expect.any(Object), "graph-1", "file-1", {
            fileName: "document.pdf",
            page: 5,
        });
        expect(openMock).toHaveBeenNthCalledWith(1, "/api/graphs/graph-1/files/file-1/document.pdf#page=1", "_blank");
        expect(openMock).toHaveBeenNthCalledWith(2, "/api/graphs/graph-1/files/file-1/document.pdf#page=5", "_blank");
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
        expect(openMock).toHaveBeenCalledWith("/api/graphs/graph-1/files/file-1/document.pdf", "_blank");
        expect(downloadProjectFile).not.toHaveBeenCalled();
    });

    test("shows selected text chunks for old page-less PDF inline citations", async () => {
        const unit = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: null,
            end_page: null,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [{ type: "text", chunk_id: 1, text: "Legacy markdown **evidence**" }],
            })
        );
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

    test("shows selected text chunks in text reference dialogs", async () => {
        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByText("Alpha evidence")).toBeInTheDocument();
        expect(document.querySelector("mark")).not.toBeInTheDocument();
        expect(fetchSourceReference).toHaveBeenCalledWith(expect.any(Object), "graph-1", "src-1");
    });

    test("reuses cached source references when reopening text reference dialogs", async () => {
        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));
        expect(await screen.findByText("Alpha evidence")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: /close/i }));
        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByText("Alpha evidence")).toBeInTheDocument();
        expect(fetchSourceReference).toHaveBeenCalledTimes(1);
    });

    test("renders multiple selected text chunks without merging them", async () => {
        const unit = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: null,
            end_page: null,
            file_name: "document.txt",
            file_type: "text",
            mime_type: "text/plain",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [
                    { type: "text", chunk_id: 1, text: "Alpha evidence" },
                    { type: "text", chunk_id: 2, text: "evidence and more" },
                ],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByText("Alpha evidence")).toBeInTheDocument();
        expect(screen.getByText("evidence and more")).toBeInTheDocument();
        expect(document.querySelector("mark")).not.toBeInTheDocument();
    });

    test("copies all selected text chunks separated by blank lines", async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
        const unit = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: null,
            end_page: null,
            file_name: "document.txt",
            file_type: "text",
            mime_type: "text/plain",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [
                    { type: "text", chunk_id: 1, text: "Alpha evidence" },
                    { type: "text", chunk_id: 2, text: "Beta evidence" },
                ],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));
        await screen.findByText("Alpha evidence");
        await userEvent.click(screen.getByRole("button", { name: /kopieren/i }));

        expect(writeText).toHaveBeenCalledWith("Alpha evidence\n\nBeta evidence");
    });

    test("shows source reference load errors inside the dialog", async () => {
        mocked(fetchSourceReference).mockRejectedValueOnce(new Error("Source failed"));

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByText("Source failed")).toBeInTheDocument();
        expect(screen.queryByText("Alpha evidence")).not.toBeInTheDocument();
    });

    test("preserves selected chunk whitespace", async () => {
        const unit = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: null,
            end_page: null,
            file_name: "document.txt",
            file_type: "text",
            mime_type: "text/plain",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [{ type: "text", chunk_id: 1, text: "Alpha   evidence\ncontinues" }],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByText(/Alpha\s+evidence\s+continues/u)).toBeInTheDocument();
        expect(document.querySelector("mark")).not.toBeInTheDocument();
    });

    test("renders image chunks as images", async () => {
        const unit: Awaited<ReturnType<typeof fetchSourceReference>>["unit"] = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: null,
            end_page: null,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [
                    {
                        type: "image",
                        chunk_id: 2,
                        image_path: "/graphs/graph-1/sources/src-1/chunks/2/image",
                        alt: "Chart image",
                    },
                ],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByRole("img", { name: "Chart image" })).toHaveAttribute(
            "src",
            "/api/graphs/graph-1/sources/src-1/chunks/2/image"
        );
    });

    test("shows image chunk alt text when protected image loading fails", async () => {
        const unit: Awaited<ReturnType<typeof fetchSourceReference>>["unit"] = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: null,
            end_page: null,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [
                    {
                        type: "image",
                        chunk_id: 2,
                        image_path: "/graphs/graph-1/sources/src-1/chunks/2/image",
                        alt: "Chart image",
                    },
                ],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));
        const image = await screen.findByRole("img", { name: "Chart image" });
        fireEvent.error(image);

        expect(screen.getByText("Chart image")).toBeInTheDocument();
        expect(screen.queryByRole("img", { name: "Chart image" })).not.toBeInTheDocument();
    });

    test("renders PDF crop regions in the inline citation dialog without chunk text", async () => {
        const unit = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: 3,
            end_page: 4,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [],
                pdf_regions: [
                    {
                        kind: "text",
                        chunk_id: 1,
                        page: 3,
                        width: 200,
                        height: 100,
                        image_path: "/graphs/graph-1/units/unit-1/pages/3.png",
                        crop: { left: 0.05, top: 0.1, width: 0.5, height: 0.2 },
                        rectangles: [],
                    },
                ],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByRole("img", { name: "document.pdf page 3" })).toHaveAttribute(
            "src",
            "/api/graphs/graph-1/units/unit-1/pages/3.png"
        );
        expect(screen.getByRole("img", { name: "document.pdf page 3" })).toHaveAttribute(
            "crossorigin",
            "use-credentials"
        );
        expect(screen.queryByText("Alpha evidence")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
        expect(document.querySelector("[data-slot='dialog-content']")).toHaveClass(
            "flex",
            "h-[80vh]",
            "overflow-hidden"
        );
        const scrollContainer = document.querySelector(".overflow-y-auto");
        expect(scrollContainer?.parentElement).toHaveClass("min-h-0", "flex-1");
        expect(scrollContainer).toHaveClass("h-full", "rounded-lg", "border");
    });

    test("groups PDF source regions from the same page into one preview image", async () => {
        const unit: Awaited<ReturnType<typeof fetchSourceReference>>["unit"] = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: 3,
            end_page: 4,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [],
                pdf_regions: [
                    {
                        kind: "text",
                        chunk_id: 1,
                        page: 3,
                        width: 200,
                        height: 100,
                        image_path: "/graphs/graph-1/units/unit-1/pages/3.png",
                        crop: { left: 0, top: 0, width: 0.5, height: 0.5 },
                        rectangles: [{ left: 0.1, top: 0.1, width: 0.1, height: 0.1 }],
                    },
                    {
                        kind: "text",
                        chunk_id: 2,
                        page: 3,
                        width: 200,
                        height: 100,
                        image_path: "/graphs/graph-1/units/unit-1/pages/3.png",
                        crop: { left: 0.4, top: 0.4, width: 0.5, height: 0.5 },
                        rectangles: [{ left: 0.6, top: 0.6, width: 0.1, height: 0.1 }],
                    },
                ],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByRole("img", { name: "document.pdf page 3" })).toBeInTheDocument();
        expect(screen.getAllByRole("img", { name: "document.pdf page 3" })).toHaveLength(1);
        expect(screen.getAllByTestId("pdf-source-region-highlight")).toHaveLength(2);
    });

    test("renders PDF source region overlays", async () => {
        const unit: Awaited<ReturnType<typeof fetchSourceReference>>["unit"] = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: 3,
            end_page: 4,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [],
                pdf_regions: [
                    {
                        kind: "text",
                        chunk_id: 1,
                        page: 3,
                        width: 200,
                        height: 100,
                        image_path: "/graphs/graph-1/units/unit-1/pages/3.png",
                        crop: { left: 0.05, top: 0.1, width: 0.5, height: 0.2 },
                        rectangles: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
                    },
                ],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        const image = await screen.findByRole("img", { name: "document.pdf page 3" });
        expect(image).toBeInTheDocument();
        expect(image).toHaveAttribute("width", "200");
        expect(image).toHaveAttribute("height", "100");
        expect(screen.getByTestId("pdf-source-region-highlight")).toHaveStyle({
            left: "10%",
            top: "20%",
            width: "30%",
            height: "4%",
        });
        expect(screen.queryByText("Alpha evidence")).not.toBeInTheDocument();
    });

    test("renders full-page PDF source regions without a full-page overlay", async () => {
        const unit: Awaited<ReturnType<typeof fetchSourceReference>>["unit"] = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: 3,
            end_page: 4,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [],
                pdf_regions: [
                    {
                        kind: "page",
                        chunk_id: 1,
                        page: 3,
                        width: 200,
                        height: 100,
                        image_path: "/graphs/graph-1/units/unit-1/pages/3.png",
                        crop: { left: 0, top: 0, width: 1, height: 1 },
                        rectangles: [{ left: 0, top: 0, width: 1, height: 1 }],
                    },
                ],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByRole("img", { name: "document.pdf page 3" })).toBeInTheDocument();
        expect(screen.queryByTestId("pdf-source-region-highlight")).not.toBeInTheDocument();
        expect(screen.getByTestId("pdf-source-page-highlight")).toHaveTextContent(/Full page|Ganze Seite/u);
    });

    test("shows selected text chunk fallback for unmatched PDF regions", async () => {
        const unit: Awaited<ReturnType<typeof fetchSourceReference>>["unit"] = {
            id: "unit-1",
            project_file_id: "file-1",
            start_page: 3,
            end_page: 3,
            file_name: "document.pdf",
            file_type: "pdf",
            mime_type: "application/pdf",
            created_at: null,
            updated_at: null,
        };
        mocked(fetchSourceReference).mockResolvedValueOnce(
            sourceReference(unit, {
                chunks: [{ type: "text", chunk_id: 1, text: "OCR-only evidence" }],
                pdf_regions: [],
            })
        );

        renderMessageContent([{ type: "text", text: `Alpha ${citationFence("src-1")} Omega` }]);

        await userEvent.click(screen.getByRole("button", { name: "1" }));

        expect(await screen.findByText("OCR-only evidence")).toBeInTheDocument();
        expect(document.querySelector("mark")).not.toBeInTheDocument();
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
        expect(openMock).toHaveBeenCalledWith("/api/graphs/graph-1/files/file-1/document.pdf#page=3", "_blank");
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
        expect(openMock).toHaveBeenCalledWith("/api/graphs/graph-1/files/file-1/document.pdf#page=3", "_blank");
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
