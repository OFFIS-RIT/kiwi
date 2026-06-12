import { describe, expect, test } from "bun:test";
import { contentDispositionForFile, contentDispositionHeader, escapeHeaderValue, parseByteRange } from "../file-proxy";

describe("file proxy helpers", () => {
    test("parses byte ranges", () => {
        expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
        expect(parseByteRange("bytes=95-", 100)).toEqual({ start: 95, end: 99 });
        expect(parseByteRange("bytes=-5", 100)).toEqual({ start: 95, end: 99 });
        expect(parseByteRange("bytes=120-140", 100)).toBe("invalid");
        expect(parseByteRange("bytes=20-10", 100)).toBe("invalid");
    });

    test("chooses inline disposition only for safe browser-displayable types", () => {
        expect(contentDispositionForFile("report.pdf", "application/pdf")).toBe("inline");
        expect(contentDispositionForFile("notes.md", "text/markdown")).toBe("inline");
        expect(contentDispositionForFile("photo.png", "image/png")).toBe("inline");
        expect(
            contentDispositionForFile(
                "deck.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            )
        ).toBe("attachment");
        expect(contentDispositionForFile("page.html", "text/html")).toBe("attachment");
        expect(contentDispositionForFile("vector.svg", "image/svg+xml")).toBe("attachment");
    });

    test("escapes content-disposition filename values", () => {
        expect(escapeHeaderValue('report"\r\n.pdf')).toBe("report___.pdf");
        expect(contentDispositionHeader("Ihre Trinkwasser Versorgung.pdf", "inline")).toBe(
            "inline; filename=\"Ihre Trinkwasser Versorgung.pdf\"; filename*=UTF-8''Ihre%20Trinkwasser%20Versorgung.pdf"
        );
    });
});
