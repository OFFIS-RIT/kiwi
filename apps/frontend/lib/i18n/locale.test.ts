import { describe, expect, test } from "vitest";
import { detectLocaleFromAcceptLanguage } from "./locale";

describe("detectLocaleFromAcceptLanguage", () => {
    test("falls back to English without a header", () => {
        expect(detectLocaleFromAcceptLanguage(undefined)).toBe("en");
    });

    test("supports English region variants", () => {
        expect(detectLocaleFromAcceptLanguage("en-US,en;q=0.9,de;q=0.8")).toBe("en");
    });

    test("respects quality values", () => {
        expect(detectLocaleFromAcceptLanguage("en-US;q=0.7,de-DE;q=0.9")).toBe("de");
    });

    test("ignores unsupported locales before falling back", () => {
        expect(detectLocaleFromAcceptLanguage("fr-FR,es;q=0.9")).toBe("en");
    });
});
