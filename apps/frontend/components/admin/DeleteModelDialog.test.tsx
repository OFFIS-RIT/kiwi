import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { deleteModel, setDefaultModel } = vi.hoisted(() => ({
    deleteModel: vi.fn(),
    setDefaultModel: vi.fn(),
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
    hasPointerCapture: { value: () => false },
    setPointerCapture: { value: () => {} },
    releasePointerCapture: { value: () => {} },
    scrollIntoView: { value: () => {} },
});

vi.mock("@/lib/api/models", () => ({
    deleteModel,
    setDefaultModel,
}));

import { renderWithProviders } from "@/test/test-utils";
import type { AdminModelListItem } from "@kiwi/contracts";
import { DeleteModelDialog } from "./DeleteModelDialog";

function makeModel(overrides: Partial<AdminModelListItem>): AdminModelListItem {
    return {
        model_id: "model-a",
        display_name: "Model A",
        type: "text",
        adapter: "openai",
        provider_model: "gpt-4.1-mini",
        url: null,
        resource_name: null,
        is_default: false,
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
        ...overrides,
    };
}

const defaultModel = makeModel({ model_id: "model-a", display_name: "Model A", is_default: true });
const oldestSibling = makeModel({
    model_id: "model-b",
    display_name: "Model B",
    created_at: "2026-06-02T00:00:00.000Z",
});
const newestSibling = makeModel({
    model_id: "model-c",
    display_name: "Model C",
    created_at: "2026-06-03T00:00:00.000Z",
});

describe("DeleteModelDialog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        deleteModel.mockResolvedValue(undefined);
        setDefaultModel.mockResolvedValue(makeModel({}));
    });

    test("deletes a non-default model without touching defaults", async () => {
        const user = userEvent.setup();
        const onDeleted = vi.fn();
        renderWithProviders(
            <DeleteModelDialog
                open
                onOpenChange={vi.fn()}
                model={makeModel({})}
                siblings={[oldestSibling]}
                onDeleted={onDeleted}
            />
        );

        expect(screen.queryByText("Neuer Standard")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Löschen" }));

        await waitFor(() => expect(onDeleted).toHaveBeenCalled());
        expect(deleteModel).toHaveBeenCalledWith(expect.anything(), "model-a");
        expect(setDefaultModel).not.toHaveBeenCalled();
    });

    test("preselects the oldest sibling, which the backend promotes anyway", async () => {
        const user = userEvent.setup();
        const onDeleted = vi.fn();
        renderWithProviders(
            <DeleteModelDialog
                open
                onOpenChange={vi.fn()}
                model={defaultModel}
                siblings={[newestSibling, oldestSibling]}
                onDeleted={onDeleted}
            />
        );

        expect(screen.getByText("Neuer Standard")).toBeInTheDocument();
        expect(screen.getByRole("combobox")).toHaveTextContent("Model B");
        await user.click(screen.getByRole("button", { name: "Löschen" }));

        await waitFor(() => expect(onDeleted).toHaveBeenCalled());
        expect(deleteModel).toHaveBeenCalledWith(expect.anything(), "model-a");
        expect(setDefaultModel).not.toHaveBeenCalled();
    });

    test("sets the chosen model as new default when it differs from the promoted one", async () => {
        const user = userEvent.setup();
        const onDeleted = vi.fn();
        renderWithProviders(
            <DeleteModelDialog
                open
                onOpenChange={vi.fn()}
                model={defaultModel}
                siblings={[newestSibling, oldestSibling]}
                onDeleted={onDeleted}
            />
        );

        await user.click(screen.getByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: "Model C" }));
        await user.click(screen.getByRole("button", { name: "Löschen" }));

        await waitFor(() => expect(onDeleted).toHaveBeenCalled());
        expect(deleteModel).toHaveBeenCalledWith(expect.anything(), "model-a");
        expect(setDefaultModel).toHaveBeenCalledWith(expect.anything(), "model-c");
    });

    test("still closes and refreshes when the deletion succeeds but the default override fails", async () => {
        setDefaultModel.mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        const onDeleted = vi.fn();
        renderWithProviders(
            <DeleteModelDialog
                open
                onOpenChange={vi.fn()}
                model={defaultModel}
                siblings={[newestSibling, oldestSibling]}
                onDeleted={onDeleted}
            />
        );

        await user.click(screen.getByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: "Model C" }));
        await user.click(screen.getByRole("button", { name: "Löschen" }));

        await waitFor(() => expect(onDeleted).toHaveBeenCalled());
        expect(deleteModel).toHaveBeenCalledWith(expect.anything(), "model-a");
        expect(setDefaultModel).toHaveBeenCalledWith(expect.anything(), "model-c");
    });

    test("warns about the deployment-wide outage when deleting the last text model", () => {
        renderWithProviders(
            <DeleteModelDialog open onOpenChange={vi.fn()} model={defaultModel} siblings={[]} onDeleted={vi.fn()} />
        );

        expect(screen.getByText(/letzte Modell vom Typ Text/)).toBeInTheDocument();
        expect(screen.getByText(/Chat ist dann für niemanden mehr verfügbar/)).toBeInTheDocument();
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
});
