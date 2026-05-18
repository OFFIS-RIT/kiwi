import { describe, expect, test } from "bun:test";
import { isSafeZipPath, resolveZipPath } from "../ooxml/package";

describe("OOXML package helpers", () => {
    test("rejects unsafe relationship targets that escape the package root", () => {
        expect(resolveZipPath("ppt/slides", "../media/image1.png")).toBe("ppt/media/image1.png");
        expect(resolveZipPath("", "../evil.xml")).toBeNull();
        expect(resolveZipPath("word", "../../evil.xml")).toBeNull();
    });

    test("rejects external and traversal zip paths", () => {
        expect(isSafeZipPath("[Content_Types].xml")).toBe(true);
        expect(isSafeZipPath("word/document.xml")).toBe(true);
        expect(isSafeZipPath("../word/document.xml")).toBe(false);
        expect(isSafeZipPath("https://example.com/image.png")).toBe(false);
    });
});
