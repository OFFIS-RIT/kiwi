import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/test-utils";
import { ClarificationBlock } from "./ClarificationBlock";

describe("ClarificationBlock", () => {
    const questions = ["Which software?", "Which vibration mode?"];

    it("preserves answer positions when submitting only a later field with Enter", () => {
        const onSubmit = vi.fn();
        renderWithProviders(<ClarificationBlock questions={questions} onSubmit={onSubmit} />);

        const secondInput = screen.getByLabelText("Which vibration mode?");
        fireEvent.change(secondInput, { target: { value: "in plane" } });
        fireEvent.keyDown(secondInput, { key: "Enter" });

        expect(onSubmit).toHaveBeenCalledWith("Which vibration mode?: in plane", ["", "in plane"]);
    });

    it("renders submitted answers in their original fields", () => {
        renderWithProviders(
            <ClarificationBlock
                questions={questions}
                onSubmit={vi.fn()}
                submitted
                submittedAnswers={["", "in plane"]}
            />
        );

        expect(screen.getByLabelText("Which software?")).toHaveValue("");
        expect(screen.getByLabelText("Which vibration mode?")).toHaveValue("in plane");
    });
});
