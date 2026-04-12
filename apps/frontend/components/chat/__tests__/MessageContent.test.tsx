import { vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LanguageProvider } from "@/providers/LanguageProvider";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { MessageContent } from "../MessageContent";

vi.mock("@/lib/api/projects", () => ({
    downloadProjectFile: vi.fn(async () => "https://example.com/download"),
}));

function renderMessageContent(parts: ChatUIMessage["parts"]) {
    localStorage.setItem("language", "en");

    return render(
        <LanguageProvider>
            <MessageContent parts={parts} projectId="graph-1" />
        </LanguageProvider>
    );
}

describe("MessageContent", () => {
    test("renders inline citation badges and source file footer", () => {
        renderMessageContent([
            { type: "text", text: "Alpha " },
            {
                type: "data-citation",
                id: "src-1",
                data: {
                    sourceId: "src-1",
                    textUnitId: "unit-1",
                    fileId: "file-1",
                    fileName: "document.pdf",
                    fileKey: "graphs/g1/document.pdf",
                    excerpt: "Alpha evidence",
                },
            },
            { type: "text", text: " Omega" },
        ]);

        expect(screen.getByText(/Alpha/)).toBeInTheDocument();
        expect(screen.getByText(/Omega/)).toBeInTheDocument();
        expect(screen.getByText("1")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /document.pdf/i })).toBeInTheDocument();
    });

    test("deduplicates source files while preserving repeated citation badges", () => {
        renderMessageContent([
            { type: "text", text: "First " },
            {
                type: "data-citation",
                id: "src-1",
                data: {
                    sourceId: "src-1",
                    textUnitId: "unit-1",
                    fileId: "file-1",
                    fileName: "document.pdf",
                    fileKey: "graphs/g1/document.pdf",
                    excerpt: "Alpha evidence",
                },
            },
            { type: "text", text: " then again " },
            {
                type: "data-citation",
                id: "src-1-repeat",
                data: {
                    sourceId: "src-1",
                    textUnitId: "unit-1",
                    fileId: "file-1",
                    fileName: "document.pdf",
                    fileKey: "graphs/g1/document.pdf",
                    excerpt: "Alpha evidence",
                },
            },
        ]);

        expect(screen.getAllByText("1")).toHaveLength(2);
        expect(screen.getAllByRole("button", { name: /document.pdf/i })).toHaveLength(1);
    });
});
