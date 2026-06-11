import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { createModel, updateModel } = vi.hoisted(() => ({
    createModel: vi.fn(),
    updateModel: vi.fn(),
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
    createModel,
    updateModel,
}));

import { renderWithProviders } from "@/test/test-utils";
import type { AdminModelListItem } from "@kiwi/contracts";
import { adapterOptionsForType, ModelFormDialog, slugifyModelId } from "./ModelFormDialog";

const adminModel: AdminModelListItem = {
    model_id: "gpt-41-mini",
    display_name: "GPT-4.1 mini",
    type: "text",
    adapter: "openai",
    provider_model: "gpt-4.1-mini",
    url: null,
    resource_name: null,
    is_default: true,
    created_at: "2026-06-09T08:02:27.000Z",
    updated_at: "2026-06-09T08:02:27.000Z",
};

const openaiApiModel: AdminModelListItem = {
    ...adminModel,
    model_id: "local-llm",
    display_name: "Local LLM",
    adapter: "openaiAPI",
    provider_model: "gpt-oss-120b",
    url: "https://llm.example.com/v1",
};

describe("slugifyModelId", () => {
    test("mirrors the backend normalization", () => {
        expect(slugifyModelId("GPT 4.1 Mini (EU)")).toBe("gpt-4.1-mini-eu");
        expect(slugifyModelId("  ---  ")).toBe("");
    });
});

describe("adapterOptionsForType", () => {
    test("offers anthropic for text models", () => {
        expect(adapterOptionsForType("text")).toContain("anthropic");
    });

    test.each(["embedding", "audio", "video"] as const)("hides anthropic for %s models", (type) => {
        expect(adapterOptionsForType(type)).not.toContain("anthropic");
        expect(adapterOptionsForType(type)).toEqual(["openai", "azure", "openaiAPI"]);
    });
});

describe("ModelFormDialog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createModel.mockResolvedValue(adminModel);
        updateModel.mockResolvedValue(adminModel);
    });

    test("creates a model with a model id slugged from the display name", async () => {
        const user = userEvent.setup();
        const onSaved = vi.fn();
        renderWithProviders(<ModelFormDialog open onOpenChange={vi.fn()} type="text" onSaved={onSaved} />);

        await user.type(screen.getByLabelText("Anzeigename"), "GPT 4.1 Mini (EU)");
        expect(screen.getByLabelText("Modell-ID")).toHaveValue("gpt-4.1-mini-eu");

        await user.type(screen.getByLabelText("Provider-Modell-Name"), "gpt-4.1-mini");
        await user.type(screen.getByLabelText("API-Schlüssel"), "secret-key");
        await user.click(screen.getByRole("button", { name: "Modell hinzufügen" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(createModel).toHaveBeenCalledWith(expect.anything(), {
            model_id: "gpt-4.1-mini-eu",
            display_name: "GPT 4.1 Mini (EU)",
            type: "text",
            adapter: "openai",
            provider_model: "gpt-4.1-mini",
            credentials: { apiKey: "secret-key" },
        });
    });

    test("keeps a manually edited model id instead of re-slugging", async () => {
        const user = userEvent.setup();
        renderWithProviders(<ModelFormDialog open onOpenChange={vi.fn()} type="text" onSaved={vi.fn()} />);

        const idInput = screen.getByLabelText("Modell-ID");
        await user.type(idInput, "my-custom-id");
        await user.type(screen.getByLabelText("Anzeigename"), "Renamed Later");

        expect(idInput).toHaveValue("my-custom-id");
    });

    test("patches only changed fields and keeps stored credentials when the key stays empty", async () => {
        const user = userEvent.setup();
        const onSaved = vi.fn();
        renderWithProviders(
            <ModelFormDialog open onOpenChange={vi.fn()} type="text" model={adminModel} onSaved={onSaved} />
        );

        const nameInput = screen.getByLabelText("Anzeigename");
        await user.clear(nameInput);
        await user.type(nameInput, "GPT-4.1 mini (renamed)");
        await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(updateModel).toHaveBeenCalledWith(expect.anything(), "gpt-41-mini", {
            display_name: "GPT-4.1 mini (renamed)",
        });
    });

    test("sends replacement credentials when a new key is entered", async () => {
        const user = userEvent.setup();
        const onSaved = vi.fn();
        renderWithProviders(
            <ModelFormDialog open onOpenChange={vi.fn()} type="text" model={adminModel} onSaved={onSaved} />
        );

        await user.type(screen.getByLabelText("API-Schlüssel"), "new-secret");
        await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(updateModel).toHaveBeenCalledWith(expect.anything(), "gpt-41-mini", {
            credentials: { apiKey: "new-secret" },
        });
    });

    test("prefills the stored endpoint URL and patches it without a new API key", async () => {
        const user = userEvent.setup();
        const onSaved = vi.fn();
        renderWithProviders(
            <ModelFormDialog open onOpenChange={vi.fn()} type="text" model={openaiApiModel} onSaved={onSaved} />
        );

        const urlInput = screen.getByLabelText("Endpunkt-URL");
        expect(urlInput).toHaveValue("https://llm.example.com/v1");
        await user.clear(urlInput);
        await user.type(urlInput, "https://other.example.com/v1");
        await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(updateModel).toHaveBeenCalledWith(expect.anything(), "local-llm", {
            credentials: { url: "https://other.example.com/v1" },
        });
    });

    test("clears the stored endpoint URL when switching the adapter away from openaiAPI", async () => {
        const user = userEvent.setup();
        const onSaved = vi.fn();
        renderWithProviders(
            <ModelFormDialog open onOpenChange={vi.fn()} type="text" model={openaiApiModel} onSaved={onSaved} />
        );

        await user.click(screen.getByRole("combobox"));
        await user.click(await screen.findByRole("option", { name: "OpenAI" }));
        expect(screen.queryByLabelText("Endpunkt-URL")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(updateModel).toHaveBeenCalledWith(expect.anything(), "local-llm", {
            adapter: "openai",
            credentials: { url: "" },
        });
    });

    test("closes without a request when nothing changed", async () => {
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        renderWithProviders(
            <ModelFormDialog open onOpenChange={onOpenChange} type="text" model={adminModel} onSaved={vi.fn()} />
        );

        await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));

        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(updateModel).not.toHaveBeenCalled();
        expect(createModel).not.toHaveBeenCalled();
    });
});
