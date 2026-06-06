import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { renderWithProviders } from "@/test/test-utils";
import { FileStatusIcon } from "./FileStatusIcon";

describe("FileStatusIcon", () => {
    test("shows the concrete process failure reason when available", () => {
        renderWithProviders(<FileStatusIcon status="failed" processErrorCode="INVALID_FILE_FORMAT" />);

        expect(screen.getByTitle("Verarbeitung fehlgeschlagen: Ungültiges Dateiformat")).toBeInTheDocument();
    });

    test("keeps the generic failed tooltip when no error code is available", () => {
        renderWithProviders(<FileStatusIcon status="failed" processErrorCode={null} />);

        expect(screen.getByTitle("Verarbeitung fehlgeschlagen")).toBeInTheDocument();
    });
});
