import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageProvider } from "@/providers/LanguageProvider";
import type { ChatUIMessage } from "@kiwi/ai/ui";
import { MessageContent } from "../MessageContent";

vi.mock("@/lib/api/projects", () => ({
    downloadProjectFile: vi.fn(async () => "https://example.com/download"),
    fetchTextUnit: vi.fn(async () => ({
        id: "unit-1",
        project_file_id: "file-1",
        text: "Alpha evidence",
        created_at: null,
        updated_at: null,
    })),
}));

function citationFence(sourceId: string) {
    return `:::{"type":"cite","sourceId":"${sourceId}","unitId":"unit-1","fileName":"document.pdf","fileKey":"graphs/g1/document.pdf"}:::`;
}

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

        const { rerender } = render(
            <LanguageProvider>
                <MessageContent parts={parts} projectId="graph-1" />
            </LanguageProvider>
        );

        await userEvent.click(screen.getByRole("button", { name: "1" }));
        expect(await screen.findByText("Alpha evidence")).toBeInTheDocument();

        rerender(
            <LanguageProvider>
                <MessageContent parts={parts} projectId="graph-1" />
            </LanguageProvider>
        );

        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByText("Alpha evidence")).toBeInTheDocument();
    });
});
