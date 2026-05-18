import { describe, expect, test } from "bun:test";
import { decodedIndexedImageToRGB, type IndexedColorSpace } from "./image";

describe("decodedIndexedImageToRGB", () => {
    test("expands 4-bit indexed samples into RGB pixels", () => {
        const colorSpace: IndexedColorSpace = {
            highValue: 3,
            componentCount: 3,
            palette: Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
        };

        const rgb = decodedIndexedImageToRGB(Uint8Array.from([0x01, 0x23]), 4, 1, 4, colorSpace);

        expect([...(rgb ?? [])]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    });

    test("leaves unsupported two-component indexed samples black", () => {
        const colorSpace: IndexedColorSpace = {
            highValue: 1,
            componentCount: 2,
            palette: Uint8Array.from([10, 20, 200, 210]),
        };

        const rgb = decodedIndexedImageToRGB(Uint8Array.from([0x01]), 2, 1, 4, colorSpace);

        expect([...(rgb ?? [])]).toEqual([0, 0, 0, 0, 0, 0]);
    });
});
