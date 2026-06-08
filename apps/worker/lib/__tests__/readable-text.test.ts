import { describe, expect, test } from "bun:test";
import { requireReadableContentText } from "../readable-text";

describe("requireReadableContentText", () => {
    test("returns content after removing page fences", () => {
        expect(requireReadableContentText(":::PAGE-1:::\n\nReadable text")).toBe("Readable text");
    });

    test("rejects empty content after page fences are removed", () => {
        expect(() => requireReadableContentText(":::PAGE-1:::")).toThrow("No readable text found in file");
    });
});
