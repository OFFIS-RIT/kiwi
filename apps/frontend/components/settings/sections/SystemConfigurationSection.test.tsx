import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { value: () => false },
    releasePointerCapture: { value: () => {} },
    scrollIntoView: { value: () => {} },
    setPointerCapture: { value: () => {} },
});

vi.mock("@/lib/api/file-types", () => ({
    fetchFileTypeConfigs: vi.fn(),
    updateFileTypeConfig: vi.fn(),
}));

vi.mock("sonner", () => ({
    toast: {
        success: vi.fn(),
        error: vi.fn(),
    },
}));

import type { FileTypeConfigRecord } from "@kiwi/contracts";
import { ApiError } from "@/lib/api/client";
import { fetchFileTypeConfigs, updateFileTypeConfig } from "@/lib/api/file-types";
import { renderWithProviders } from "@/test/test-utils";
import { toast } from "sonner";
import { SystemConfigurationSection } from "./SystemConfigurationSection";

const records: FileTypeConfigRecord[] = [
    {
        file_type: "pdf",
        loader: "pdf",
        chunker: "semantic",
        chunk_size: 2000,
        document_mode: "hybrid",
        chunk_size_editable: true,
        document_mode_editable: true,
    },
    {
        file_type: "image",
        loader: "image",
        chunker: "single",
        chunk_size: null,
        document_mode: null,
        chunk_size_editable: false,
        document_mode_editable: false,
    },
    {
        file_type: "csv",
        loader: "csv",
        chunker: "csv",
        chunk_size: 500,
        document_mode: null,
        chunk_size_editable: true,
        document_mode_editable: false,
    },
    {
        file_type: "code",
        loader: "text",
        chunker: "semantic",
        chunk_size: 2000,
        document_mode: null,
        chunk_size_editable: true,
        document_mode_editable: false,
    },
];

const fetchFileTypeConfigsMock = vi.mocked(fetchFileTypeConfigs);
const updateFileTypeConfigMock = vi.mocked(updateFileTypeConfig);

function renderSection() {
    renderWithProviders(<SystemConfigurationSection />);
}

describe("SystemConfigurationSection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchFileTypeConfigsMock.mockResolvedValue(records);
        updateFileTypeConfigMock.mockResolvedValue({ ...records[0]!, chunk_size: 1600 });
    });

    test("renders file processing config with fixed loader and chunker values", async () => {
        renderSection();

        expect(await screen.findByText("Dateiverarbeitung")).toBeInTheDocument();
        expect(await screen.findByText("4 Dateitypen geladen")).toBeInTheDocument();
        expect(screen.getByText("Dokumente")).toBeInTheDocument();
        expect(screen.getByText("Medien")).toBeInTheDocument();
        const pdfRow = screen.getByText("PDF").closest("[data-file-type='pdf']");
        expect(pdfRow).not.toBeNull();
        expect(within(pdfRow!).getByText("pdf")).toBeInTheDocument();
        expect(within(pdfRow!).getByText("semantic")).toBeInTheDocument();
        expect(screen.getByText("Code")).toBeInTheDocument();
        expect(screen.getByText(".js, .ts, .tsx, .rs, .zig, .c, .h")).toBeInTheDocument();
    });

    test("keeps save disabled until an editable field changes", async () => {
        const user = userEvent.setup();
        renderSection();

        const input = await screen.findByLabelText("Chunk-Größe für PDF");
        const saveButton = screen.getByRole("button", { name: "Alle Änderungen speichern" });

        expect(saveButton).toBeDisabled();

        await user.clear(input);
        await user.type(input, "1600");
        expect(saveButton).toBeEnabled();

        await user.click(saveButton);
        await waitFor(() =>
            expect(updateFileTypeConfigMock).toHaveBeenCalledWith(expect.anything(), "pdf", { chunk_size: 1600 })
        );
    });

    test("saves all changed file types together", async () => {
        const user = userEvent.setup();
        renderSection();

        const pdfInput = await screen.findByLabelText("Chunk-Größe für PDF");
        const csvInput = await screen.findByLabelText("Chunk-Größe für CSV");

        await user.clear(pdfInput);
        await user.type(pdfInput, "1600");
        await user.clear(csvInput);
        await user.type(csvInput, "750");
        await user.click(screen.getByRole("button", { name: "Alle Änderungen speichern" }));

        await waitFor(() => expect(updateFileTypeConfigMock).toHaveBeenCalledTimes(2));
        expect(updateFileTypeConfigMock).toHaveBeenNthCalledWith(1, expect.anything(), "pdf", { chunk_size: 1600 });
        expect(updateFileTypeConfigMock).toHaveBeenNthCalledWith(2, expect.anything(), "csv", { chunk_size: 750 });
    });

    test("saves changed document mode", async () => {
        const user = userEvent.setup();
        renderSection();

        await user.click(await screen.findByRole("combobox", { name: "Extraktionsmodus für PDF" }));
        await user.click(await screen.findByRole("option", { name: "Text" }));
        await user.click(screen.getByRole("button", { name: "Alle Änderungen speichern" }));

        await waitFor(() =>
            expect(updateFileTypeConfigMock).toHaveBeenCalledWith(expect.anything(), "pdf", {
                document_mode: "plain",
            })
        );
    });

    test("validates chunk size before saving", async () => {
        const user = userEvent.setup();
        renderSection();

        const input = await screen.findByLabelText("Chunk-Größe für CSV");
        const row = input.closest("[data-file-type='csv']");
        expect(row).not.toBeNull();

        await user.clear(input);
        await user.type(input, "25");

        expect(within(row!).getByText("Mindestens 50 Token.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Alle Änderungen speichern" })).toBeDisabled();
    });

    test("does not treat equivalent numeric chunk size formatting as a change", async () => {
        const user = userEvent.setup();
        renderSection();

        const input = await screen.findByLabelText("Chunk-Größe für PDF");

        await user.clear(input);
        await user.type(input, "02000");

        expect(screen.getByRole("button", { name: "Alle Änderungen speichern" })).toBeDisabled();
    });

    test("resets all pending changes together", async () => {
        const user = userEvent.setup();
        renderSection();

        const input = await screen.findByLabelText("Chunk-Größe für PDF");
        const saveButton = screen.getByRole("button", { name: "Alle Änderungen speichern" });

        await user.clear(input);
        await user.type(input, "1600");
        expect(saveButton).toBeEnabled();

        await user.click(screen.getByRole("button", { name: "Alle Änderungen zurücksetzen" }));

        expect(input).toHaveValue(2000);
        expect(saveButton).toBeDisabled();
    });

    test("shows load errors and can retry loading file type configs", async () => {
        const user = userEvent.setup();
        fetchFileTypeConfigsMock.mockRejectedValueOnce(new Error("boom"));
        renderSection();

        expect(
            await screen.findByText("Dateiverarbeitungseinstellungen konnten nicht geladen werden.")
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Erneut versuchen" }));

        expect(await screen.findByText("4 Dateitypen geladen")).toBeInTheDocument();
        expect(fetchFileTypeConfigsMock).toHaveBeenCalledTimes(2);
    });

    test("shows the file type when saving a later bulk update fails", async () => {
        const user = userEvent.setup();
        updateFileTypeConfigMock.mockImplementation(async (_client, fileType) => {
            if (fileType === "csv") {
                throw new ApiError("invalid", 400, "Bad Request", "", "INVALID_FILE_TYPE_CONFIG");
            }

            return { ...records[0]!, chunk_size: 1600 };
        });
        renderSection();

        const pdfInput = await screen.findByLabelText("Chunk-Größe für PDF");
        const csvInput = await screen.findByLabelText("Chunk-Größe für CSV");

        await user.clear(pdfInput);
        await user.type(pdfInput, "1600");
        await user.clear(csvInput);
        await user.type(csvInput, "750");
        await user.click(screen.getByRole("button", { name: "Alle Änderungen speichern" }));

        await waitFor(() => expect(updateFileTypeConfigMock).toHaveBeenCalledTimes(2));
        expect(toast.error).toHaveBeenCalledWith(
            "Fehler bei CSV: Diese Konfiguration ist für den Dateityp nicht erlaubt."
        );
        await waitFor(() => expect(fetchFileTypeConfigsMock).toHaveBeenCalledTimes(2));
        expect(csvInput).toHaveValue(750);
    });

    test("does not restore preserved failed drafts after resetting all changes", async () => {
        const user = userEvent.setup();
        let currentRecords = records;
        let failFirstSave = true;
        fetchFileTypeConfigsMock.mockImplementation(async () => currentRecords);
        updateFileTypeConfigMock.mockImplementation(async (_client, fileType, input) => {
            if (failFirstSave) {
                throw new ApiError("invalid", 400, "Bad Request", "", "INVALID_FILE_TYPE_CONFIG");
            }

            const updatedRecord = {
                ...records.find((record) => record.file_type === fileType)!,
                chunk_size: input.chunk_size ?? null,
            };
            currentRecords = currentRecords.map((record) => (record.file_type === fileType ? updatedRecord : record));
            return updatedRecord;
        });
        renderSection();

        const pdfInput = await screen.findByLabelText("Chunk-Größe für PDF");
        const csvInput = await screen.findByLabelText("Chunk-Größe für CSV");

        await user.clear(pdfInput);
        await user.type(pdfInput, "1600");
        await user.clear(csvInput);
        await user.type(csvInput, "750");
        await user.click(screen.getByRole("button", { name: "Alle Änderungen speichern" }));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "Fehler bei PDF: Diese Konfiguration ist für den Dateityp nicht erlaubt."
            )
        );

        await user.click(screen.getByRole("button", { name: "Alle Änderungen zurücksetzen" }));
        expect(pdfInput).toHaveValue(2000);
        expect(csvInput).toHaveValue(500);

        failFirstSave = false;
        await user.clear(csvInput);
        await user.type(csvInput, "750");
        await user.click(screen.getByRole("button", { name: "Alle Änderungen speichern" }));

        await waitFor(() => expect(updateFileTypeConfigMock).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(fetchFileTypeConfigsMock).toHaveBeenCalledTimes(3));
        expect(pdfInput).toHaveValue(2000);
    });

    test("shows non-editable values as not applicable instead of disabled form controls", async () => {
        renderSection();

        const imageCell = await screen.findByText("Bilder");
        const row = imageCell.closest("[data-file-type='image']");
        expect(row).not.toBeNull();

        expect(within(row!).queryByRole("spinbutton")).not.toBeInTheDocument();
        expect(within(row!).getAllByText("Nicht anwendbar")).toHaveLength(2);
    });
});
