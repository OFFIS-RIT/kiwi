import { describe, expect, test } from "bun:test";

import { ODTLoader } from "../odt.ts";

const ODT_BASE64 =
    "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";

async function buildFixture(): Promise<{
    plain: string;
    ocrText: string;
}> {
    const bytes = Uint8Array.from(Buffer.from(ODT_BASE64, "base64"));
    const loader = {
        getText: async () => Buffer.from(bytes).toString(),
        getBinary: async () => bytes.slice().buffer,
    };

    const plain = await new ODTLoader({ loader }).getText();
    const ocrText = await new ODTLoader({ loader, ocr: true }).getText();

    return { plain, ocrText };
}

describe("ODTLoader", () => {
    test("returns plain text without image fences", async () => {
        const fixture = await buildFixture();

        expect(fixture.plain).toContain("ODT Loader Title");
        expect(fixture.plain).toContain("Alpha before image.");
        expect(fixture.plain).toContain("Omega after image.");
        expect(fixture.plain).toContain("First bullet");
        expect(fixture.plain).toContain("Name");
        expect(fixture.plain).toMatch(/\| Foo \| 42 \|/);
        expect(fixture.plain).not.toMatch(/:::IMG-img-1:::/);
    });

    test("returns OCR markdown with headings bullets tables styling and image fences", async () => {
        const fixture = await buildFixture();

        expect(fixture.ocrText).toMatch(/^# ODT Loader Title$/m);
        expect(fixture.ocrText).toContain("Alpha **before** image.");
        expect(fixture.ocrText).toMatch(/:::IMG-img-1:::/);
        expect(fixture.ocrText).toMatch(/Omega after image\./);
        expect(fixture.ocrText).toMatch(/^- First bullet$/m);
        expect(fixture.ocrText).toMatch(/\| Name \| Value \|/);
        expect(fixture.ocrText).toMatch(/\| Foo \| 42 \|/);
    });
});
