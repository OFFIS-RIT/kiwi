import { beforeEach, describe, expect, mock, test } from "bun:test";

const generateTextMock = mock(async () => ({
    text: "Slide image summary",
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

const { PPTXLoader } = await import("../ppt.ts");

const PPTX_BASE64 =
    "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";

async function buildFixture(): Promise<{
    plain: string;
    ocrText: string;
}> {
    const bytes = Uint8Array.from(Buffer.from(PPTX_BASE64, "base64"));
    const loader = {
        getText: async () => Buffer.from(bytes).toString(),
        getBinary: async () => bytes.slice().buffer,
    };

    const plain = await new PPTXLoader({ loader }).getText();
    const ocrText = await new PPTXLoader({
        loader,
        ocr: true,
        model: {} as never,
        storage: { bucket: "bucket", imagePrefix: "graphs/graph-1/derived/file-1/images" },
    }).getText();

    return { plain, ocrText };
}

describe("PPTXLoader", () => {
    beforeEach(() => {
        generateTextMock.mockClear();
        putNamedFileMock.mockClear();
    });

    test("returns markdown slide content without image fences in plain mode", async () => {
        const fixture = await buildFixture();

        expect(fixture.plain).toMatch(/^# PPT Loader Title$/m);
        expect(fixture.plain).toContain("Alpha before image.");
        expect(fixture.plain).toMatch(/^- First bullet$/m);
        expect(fixture.plain).not.toMatch(/:::IMG-img-1:::/);
        expect(fixture.plain).toMatch(/\| Name \| Value \|/);
        expect(fixture.plain).toMatch(/\| Foo \| 42 \|/);
        expect(fixture.plain).toContain("Omega after table.");
    });

    test("returns persisted image tags when ocr is enabled", async () => {
        const fixture = await buildFixture();

        expect(fixture.ocrText).toContain(
            '<image id="img-1" key="graphs/graph-1/derived/file-1/images/img-1.png">Slide image summary</image>'
        );
        expect(fixture.ocrText).not.toMatch(/:::IMG-img-1:::/);
        expect(fixture.ocrText).toContain("Omega after table.");
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(putNamedFileMock).toHaveBeenCalledTimes(1);
    });
});
