import { beforeEach, describe, expect, mock, test } from "bun:test";

const generateTextMock = mock(async () => ({
    text: 'Embedded <diagram> & "caption"',
}));

const putNamedFileMock = mock(async (name: string, _file: Uint8Array, path: string) => ({
    key: `${path}/${name}`,
    type: "image/png",
}));

mock.module("ai", () => ({
    generateText: generateTextMock,
}));

mock.module("@kiwi/files", () => ({
    putNamedFile: putNamedFileMock,
}));

const { DOCXLoader } = await import("../doc.ts");

const DOCX_BASE64 =
    "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";

async function buildFixture(): Promise<{
    plain: string;
    ocrText: string;
}> {
    const bytes = Uint8Array.from(Buffer.from(DOCX_BASE64, "base64"));
    const loader = {
        getText: async () => Buffer.from(bytes).toString(),
        getBinary: async () => bytes.slice().buffer,
    };

    const plain = await new DOCXLoader({ loader }).getText();
    const ocrText = await new DOCXLoader({
        loader,
        ocr: true,
        model: {} as never,
        storage: { bucket: "bucket", imagePrefix: "graphs/graph-1/derived/file-1/images" },
    }).getText();

    return {
        plain,
        ocrText,
    };
}

describe("DOCXLoader", () => {
    beforeEach(() => {
        generateTextMock.mockClear();
        putNamedFileMock.mockClear();
    });

    test("returns plain text without image fences", async () => {
        const fixture = await buildFixture();

        expect(fixture.plain).toContain("Doc Loader Title");
        expect(fixture.plain).toContain("Alpha before image.");
        expect(fixture.plain).toContain("Omega after image.");
        expect(fixture.plain).toContain("Name");
        expect(fixture.plain).toContain("42");
        expect(fixture.plain).not.toMatch(/:::IMG-img-1:::/);
        expect(fixture.plain).not.toContain("<image ");
    });

    test("returns OCR markdown with headings tables and persisted image tags", async () => {
        const fixture = await buildFixture();

        expect(fixture.ocrText).toMatch(/^# Doc Loader Title$/m);
        expect(fixture.ocrText).toMatch(/Alpha before image\./);
        expect(fixture.ocrText).toContain(
            '<image id="img-1" key="graphs/graph-1/derived/file-1/images/img-1.png">Embedded &lt;diagram&gt; &amp; &quot;caption&quot;</image>'
        );
        expect(fixture.ocrText).not.toMatch(/:::IMG-img-1:::/);
        expect(fixture.ocrText).toMatch(/Omega after image\./);
        expect(fixture.ocrText).toMatch(/\| Name \| Value \|/);
        expect(fixture.ocrText).toMatch(/\| Foo \| 42 \|/);
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(putNamedFileMock).toHaveBeenCalledTimes(1);
    });
});
