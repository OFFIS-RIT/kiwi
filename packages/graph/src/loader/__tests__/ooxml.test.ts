import { describe, expect, mock, test } from "bun:test";
import { extractEmbeddedOfficeDocumentText } from "../ooxml/embedded";
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

    test("uses the OOXML content type when an embedded package path lacks a useful extension", async () => {
        const docxReader = mock(async () => "embedded doc");

        await expect(
            extractEmbeddedOfficeDocumentText({
                content: new ArrayBuffer(0),
                partPath: "word/embeddings/oleObject1.bin",
                contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                depth: 0,
                readers: { docx: docxReader },
            })
        ).resolves.toBe("embedded doc");

        expect(docxReader).toHaveBeenCalledTimes(1);
    });
});
