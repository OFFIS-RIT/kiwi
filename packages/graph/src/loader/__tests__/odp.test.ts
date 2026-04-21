import { describe, expect, test } from "bun:test";

import { ODPLoader } from "../odp.ts";

const ODP_BASE64 =
    "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";

async function buildFixture(): Promise<{
    plain: string;
    ocrText: string;
}> {
    const bytes = Uint8Array.from(Buffer.from(ODP_BASE64, "base64"));
    const loader = {
        getText: async () => Buffer.from(bytes).toString(),
        getBinary: async () => bytes.slice().buffer,
    };

    const plain = await new ODPLoader({ loader }).getText();
    const ocrText = await new ODPLoader({ loader, ocr: true }).getText();

    return { plain, ocrText };
}

describe("ODPLoader", () => {
    test("returns plain text without image fences", async () => {
        const fixture = await buildFixture();

        expect(fixture.plain).toContain("ODP Loader Title");
        expect(fixture.plain).toContain("Alpha before image.");
        expect(fixture.plain).toContain("First bullet");
        expect(fixture.plain).toContain("Name");
        expect(fixture.plain).toMatch(/\| Foo \| 42 \|/);
        expect(fixture.plain).toContain("Omega after table.");
        expect(fixture.plain).toContain("Second slide body.");
        expect(fixture.plain).not.toMatch(/:::IMG-img-1:::/);
    });

    test("returns OCR markdown with headings bullets tables and image fences", async () => {
        const fixture = await buildFixture();

        expect(fixture.ocrText).toMatch(/^# ODP Loader Title$/m);
        expect(fixture.ocrText).toMatch(/Alpha before image\./);
        expect(fixture.ocrText).toMatch(/^- First bullet$/m);
        expect(fixture.ocrText).toMatch(/:::IMG-img-1:::/);
        expect(fixture.ocrText).toMatch(/\| Name \| Value \|/);
        expect(fixture.ocrText).toMatch(/\| Foo \| 42 \|/);
        expect(fixture.ocrText).toMatch(/Omega after table\./);
        expect(fixture.ocrText).toMatch(/## Slide 2/);
        expect(fixture.ocrText).toMatch(/Second slide body\./);
    });
});
