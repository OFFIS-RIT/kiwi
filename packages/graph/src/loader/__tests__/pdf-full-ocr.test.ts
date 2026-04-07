import { describe, expect, mock, test } from "bun:test";

import { extractFullOCRTextFromPDF } from "../pdf.ts";

describe("extractFullOCRTextFromPDF", () => {
    test("joins multiple transcribed pages in order", async () => {
        const rasterizePages = mock(async () => [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
        const transcribePage = mock(async (image: Uint8Array) => {
            if (image[0] === 1) {
                return "  # Page 1\nAlpha  ";
            }
            if (image[0] === 2) {
                return "## Page 2\nBeta";
            }

            return "";
        });

        const text = await extractFullOCRTextFromPDF(new Uint8Array([9]).buffer, {} as never, {
            rasterizePages,
            transcribePage,
        });

        expect(text).toBe("# Page 1\nAlpha\n\n## Page 2\nBeta");
        expect(rasterizePages).toHaveBeenCalledTimes(1);
        expect(transcribePage).toHaveBeenCalledTimes(3);
    });

    test("propagates rasterization failures", async () => {
        const rasterizePages = mock(async () => {
            throw new Error("rasterize failed");
        });

        await expect(
            extractFullOCRTextFromPDF(new Uint8Array([9]).buffer, {} as never, {
                rasterizePages,
            })
        ).rejects.toThrow("rasterize failed");
    });

    test("propagates transcription failures", async () => {
        const transcribePage = mock(async () => {
            throw new Error("transcribe failed");
        });

        await expect(
            extractFullOCRTextFromPDF(new Uint8Array([9]).buffer, {} as never, {
                rasterizePages: async () => [new Uint8Array([1])],
                transcribePage,
            })
        ).rejects.toThrow("transcribe failed");
    });
});
