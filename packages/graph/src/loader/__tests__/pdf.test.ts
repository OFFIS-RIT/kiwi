import { beforeEach, describe, expect, mock, test } from "bun:test";
import { PDF, degrees, measureText, rgb } from "@libpdf/core";
import { transcribePrompt } from "@kiwi/ai/prompts/transcribe.prompt";

let fullOCRPageOutputs: string[] = [];
let rasterizedPages: Uint8Array[] = [];

const generateTextMock = mock(async ({ system }: { system?: string }) => {
    if (system === transcribePrompt) {
        return {
            text: fullOCRPageOutputs.shift() ?? "",
        };
    }

    return {
        text: "PDF figure summary",
    };
});

const putNamedFileMock = mock(async (name: string, _file: Uint8Array, path: string) => ({
    key: `${path}/${name}`,
    type: "image/png",
}));

const pdfToImgMock = mock(async () => {
    const pages = rasterizedPages.map((page) => Buffer.from(page));

    return {
        length: pages.length,
        metadata: {},
        getPage: async (pageNumber: number) => Buffer.from(pages[pageNumber - 1] ?? []),
        async *[Symbol.asyncIterator]() {
            for (const page of pages) {
                yield Buffer.from(page);
            }
        },
    };
});

mock.module("ai", () => ({
    generateText: generateTextMock,
}));

mock.module("@kiwi/files", () => ({
    putNamedFile: putNamedFileMock,
}));

mock.module("pdf-to-img", () => ({
    pdf: pdfToImgMock,
}));

const { PDFLoader } = await import("../pdf.ts");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6rmS0AAAAASUVORK5CYII=";

function drawPositionedTable(
    page: ReturnType<PDF["addPage"]>,
    xs: number[],
    startY: number,
    rows: string[][],
    size = 12,
    rowGap = 28
): void {
    rows.forEach((row, rowIndex) => {
        const y = startY - rowIndex * rowGap;
        row.forEach((cell, columnIndex) => {
            if (!cell) {
                return;
            }

            page.drawText(cell, { x: xs[columnIndex]!, y, size });
        });
    });
}

function drawLineRows(
    page: ReturnType<PDF["addPage"]>,
    x: number,
    startY: number,
    rows: string[],
    size = 12,
    rowGap = 24
): void {
    rows.forEach((row, rowIndex) => {
        page.drawText(row, { x, y: startY - rowIndex * rowGap, size });
    });
}

function drawTrackedText(
    page: ReturnType<PDF["addPage"]>,
    text: string,
    x: number,
    y: number,
    size = 12,
    extraGap = 0,
    font: Parameters<typeof measureText>[1] = "Helvetica"
): void {
    let cursor = x;
    for (const char of text) {
        if (char !== " ") {
            page.drawText(char, { x: cursor, y, size, font });
        }
        cursor += measureText(char, font, size) + extraGap;
    }
}

async function buildPDFBinary(build: (pdf: PDF) => Promise<void> | void): Promise<Uint8Array> {
    const pdf = PDF.create();
    await build(pdf);
    return await pdf.save();
}

async function buildHybridFixture(build: (pdf: PDF) => Promise<void> | void): Promise<{
    plain: string;
    hybrid: string;
}> {
    const bytes = await buildPDFBinary(build);
    return buildHybridFixtureFromBytes(bytes);
}

async function buildHybridFixtureFromBytes(bytes: Uint8Array): Promise<{
    plain: string;
    hybrid: string;
}> {
    const loader = {
        getText: async () => Buffer.from(bytes).toString(),
        getBinary: async () => bytes.slice().buffer,
    };

    const plain = await new PDFLoader({ loader, mode: "plain" }).getText();
    const hybrid = await new PDFLoader({
        loader,
        mode: "hybrid",
        model: {} as never,
        storage: { bucket: "bucket", imagePrefix: "graphs/graph-1/derived/file-1/images" },
    }).getText();

    return {
        plain,
        hybrid,
    };
}

function patchContentStreams(bytes: Uint8Array, transform: (stream: string) => string): Uint8Array {
    const source = Buffer.from(bytes).toString("latin1");
    const patched = source.replace(/\/Length\s+(\d+)>>\nstream\n([\s\S]*?)endstream/g, (_match, _length, stream) => {
        const nextStream = transform(stream);
        return `/Length ${Buffer.byteLength(nextStream, "latin1")}>>\nstream\n${nextStream}endstream`;
    });

    return Uint8Array.from(Buffer.from(patched, "latin1"));
}

function injectPropertiesResource(bytes: Uint8Array, name: string, body: string): Uint8Array {
    const source = Buffer.from(bytes).toString("latin1");
    const patched = source.replace(/\/Resources <<\n([\s\S]*?)>>\n\/Parent/, (_match, resources) => {
        return `/Resources <<\n${resources}/Properties <<\n/${name} ${body}\n>>\n>>\n/Parent`;
    });

    return Uint8Array.from(Buffer.from(patched, "latin1"));
}

function encodeUtf16BEHex(value: string): string {
    const bytes = [
        0xfe,
        0xff,
        ...Array.from(value).flatMap((char) => {
            const code = char.codePointAt(0) ?? 0;
            return [(code >> 8) & 0xff, code & 0xff];
        }),
    ];
    return bytes
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
}

async function buildLineTableFixture() {
    return buildHybridFixture(async (pdf) => {
        const pngBytes = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Main Title", { x: 50, y: 740, size: 24 });
        page.drawText("Alpha Omega", { x: 50, y: 680, size: 12, color: rgb(0, 0, 0) });

        const image = pdf.embedPng(pngBytes);
        page.drawImage(image, { x: 78, y: 676, width: 18, height: 18 });

        const x0 = 50;
        const x1 = 170;
        const x2 = 290;
        const y0 = 520;
        const y1 = 548;
        const y2 = 576;
        const y3 = 604;

        for (const x of [x0, x1, x2]) {
            page.drawLine({ start: { x, y: y0 }, end: { x, y: y3 }, thickness: 1, color: rgb(0, 0, 0) });
        }

        for (const y of [y0, y1, y2, y3]) {
            page.drawLine({ start: { x: x0, y }, end: { x: x2, y }, thickness: 1, color: rgb(0, 0, 0) });
        }

        drawPositionedTable(page, [60, 180], 585, [
            ["Name", "Value"],
            ["Foo", "42"],
            ["Bar", "84"],
        ]);
    });
}

async function buildAlignedTextTableFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Aligned Text Table", { x: 210, y: 740, size: 22 });
        drawPositionedTable(page, [50, 180, 320], 620, [
            ["Item", "Weight", "Time"],
            ["", "[kg]", "[ms]"],
            ["Rotor", "12", "30"],
            ["Stator", "18", "41"],
            ["Frame", "24", "55"],
        ]);
    });
}

async function buildMathTableFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Math Table", { x: 225, y: 740, size: 22 });

        const x0 = 50;
        const x1 = 170;
        const x2 = 310;
        const y0 = 520;
        const y1 = 548;
        const y2 = 576;
        const y3 = 604;

        for (const x of [x0, x1, x2]) {
            page.drawLine({ start: { x, y: y0 }, end: { x, y: y3 }, thickness: 1, color: rgb(0, 0, 0) });
        }

        for (const y of [y0, y1, y2, y3]) {
            page.drawLine({ start: { x: x0, y }, end: { x: x2, y }, thickness: 1, color: rgb(0, 0, 0) });
        }

        page.drawText("Expr", { x: 60, y: 585, size: 12 });
        page.drawText("Expr", { x: 60, y: 585, size: 12 });
        page.drawText("Meaning", { x: 180, y: 585, size: 12 });

        page.drawText("x", { x: 60, y: 557, size: 12 });
        page.drawText("2", { x: 67, y: 563, size: 8 });
        page.drawText("square", { x: 180, y: 557, size: 12 });

        page.drawText("H", { x: 60, y: 529, size: 12 });
        page.drawText("2", { x: 67, y: 525, size: 8 });
        page.drawText("O", { x: 73, y: 529, size: 12 });
        page.drawText("water", { x: 180, y: 529, size: 12 });
    });
}

async function buildWhitespaceSeparatedTableFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Whitespace Segments", { x: 210, y: 740, size: 22 });
        drawLineRows(page, 50, 620, [
            "City          Score          Rank",
            "Berlin        91             1",
            "Leipzig       84             2",
            "Essen         77             3",
        ]);
    });
}

async function buildRotatedTextFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Rotation Examples", { x: 180, y: 740, size: 22 });
        page.drawText("Body text", { x: 220, y: 620, size: 12 });
        page.drawText("Y Axis", { x: 70, y: 520, size: 12, rotate: degrees(90) });
        page.drawText("Z Axis", { x: 520, y: 620, size: 12, rotate: degrees(270) });
    });
}

async function buildRotatedHeaderTableFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Rotated Headers", { x: 195, y: 740, size: 22 });

        const x0 = 60;
        const x1 = 140;
        const x2 = 240;
        const x3 = 340;
        const y0 = 470;
        const y1 = 520;
        const y2 = 570;
        const y3 = 620;

        for (const x of [x0, x1, x2, x3]) {
            page.drawLine({ start: { x, y: y0 }, end: { x, y: y3 }, thickness: 1, color: rgb(0, 0, 0) });
        }

        for (const y of [y0, y1, y2, y3]) {
            page.drawLine({ start: { x: x0, y }, end: { x: x3, y }, thickness: 1, color: rgb(0, 0, 0) });
        }

        page.drawText("Name", { x: 92, y: 572, size: 12, rotate: degrees(90) });
        page.drawText("Kind", { x: 188, y: 602, size: 12, rotate: degrees(270) });
        page.drawText("Value", { x: 260, y: 585, size: 12 });

        drawPositionedTable(
            page,
            [76, 166, 266],
            535,
            [
                ["Rotor", "Part", "12"],
                ["Stator", "Part", "18"],
            ],
            12,
            25
        );
    });
}

async function buildTaggedActualTextFixture() {
    const bytes = await buildPDFBinary((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Tagged Math", { x: 220, y: 740, size: 22 });
        page.drawText("Visible:", { x: 60, y: 640, size: 12 });
        page.drawText("x", { x: 110, y: 640, size: 12 });
        page.drawText("done", { x: 130, y: 640, size: 12 });
    });

    const patched = patchContentStreams(bytes, (stream) => {
        return stream.replace(/<78> Tj/, "/Span << /ActualText (x squared) /MCID 0 >> BDC\n<78> Tj\nEMC");
    });

    return buildHybridFixtureFromBytes(patched);
}

async function buildTaggedTableFixture() {
    const bytes = await buildPDFBinary((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Tagged Table", { x: 220, y: 740, size: 22 });

        const x0 = 50;
        const x1 = 170;
        const x2 = 310;
        const y0 = 520;
        const y1 = 548;
        const y2 = 576;
        const y3 = 604;

        for (const x of [x0, x1, x2]) {
            page.drawLine({ start: { x, y: y0 }, end: { x, y: y3 }, thickness: 1, color: rgb(0, 0, 0) });
        }

        for (const y of [y0, y1, y2, y3]) {
            page.drawLine({ start: { x: x0, y }, end: { x: x2, y }, thickness: 1, color: rgb(0, 0, 0) });
        }

        drawPositionedTable(page, [60, 180], 585, [
            ["Expr", "Meaning"],
            ["x", "square"],
            ["n", "count"],
        ]);
    });

    const withProperties = injectPropertiesResource(
        bytes,
        "MC0",
        `<< /ActualText <${encodeUtf16BEHex("x^2")}>
/MCID 0
>>`
    );
    const patched = patchContentStreams(withProperties, (stream) => {
        return stream.replace(/<78> Tj/, "/Span /MC0 BDC\n<78> Tj\nEMC");
    });

    return buildHybridFixtureFromBytes(patched);
}

async function buildAdaptiveBoundaryFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Adaptive Boundaries", { x: 170, y: 740, size: 22 });
        drawTrackedText(page, "TrackedWord", 60, 660, 12, 3.6);
        page.drawText("Alpha", { x: 60, y: 628, size: 12 });
        page.drawText("Beta", { x: 104, y: 628, size: 12 });
        drawTrackedText(page, "api_v1/test.ts", 60, 596, 12, 2.6);
        drawTrackedText(page, "H2SO4", 60, 564, 12, 2.8);
        drawTrackedText(page, "f(x,y)=n+1", 60, 532, 12, 2.2);
    });
}

async function buildAdaptiveWhitespaceTableFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Adaptive Table", { x: 205, y: 740, size: 22 });

        const rows = [
            ["Key", "Formula", "Value"],
            ["api_v1", "H2SO4", "42"],
            ["file.ts", "f(x,y)", "17"],
        ];

        rows.forEach((row, rowIndex) => {
            const y = 620 - rowIndex * 28;
            drawTrackedText(page, row[0]!, 50, y, 12, rowIndex === 0 ? 0 : 2.6);
            drawTrackedText(page, row[1]!, 190, y, 12, rowIndex === 0 ? 0 : 2.2);
            page.drawText(row[2]!, { x: 330, y, size: 12 });
        });
    });
}

async function buildRepeatedEdgeFixture() {
    return buildHybridFixture((pdf) => {
        for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
            const page = pdf.addPage({ size: "letter" });

            page.drawText("Quarterly Status Report", { x: 170, y: 744, size: 12 });
            page.drawText(`Page ${pageIndex + 1}`, { x: 280, y: 32, size: 10 });
            page.drawText(`Section ${pageIndex + 1}`, { x: 60, y: 664, size: 18 });
            drawLineRows(page, 60, 620, [
                `Summary line ${pageIndex + 1}`,
                `Detail ${pageIndex + 1}A for the current revision`,
                `Detail ${pageIndex + 1}B with measured values`,
            ]);
        }
    });
}

async function buildTaggedAdjacentActualTextFixture() {
    const bytes = await buildPDFBinary((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Adjacent Tags", { x: 220, y: 740, size: 22 });
        page.drawText("Formula:", { x: 60, y: 640, size: 12 });
        page.drawText("x", { x: 122, y: 640, size: 12 });
        page.drawText("+", { x: 132, y: 640, size: 12 });
        page.drawText("y", { x: 142, y: 640, size: 12 });
    });

    const patched = patchContentStreams(bytes, (stream) => {
        return stream
            .replace(/<78> Tj/, "/Span << /ActualText (x^2) /MCID 0 >> BDC\n<78> Tj\nEMC")
            .replace(/<79> Tj/, "/Span << /ActualText (y^2) /MCID 1 >> BDC\n<79> Tj\nEMC");
    });

    return buildHybridFixtureFromBytes(patched);
}

async function buildTableWithEmbeddedImageFixture() {
    return buildHybridFixture(async (pdf) => {
        const pngBytes = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
        const image = pdf.embedPng(pngBytes);
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Image In Table", { x: 205, y: 740, size: 22 });

        const x0 = 50;
        const x1 = 190;
        const x2 = 330;
        const y0 = 500;
        const y1 = 548;
        const y2 = 596;

        for (const x of [x0, x1, x2]) {
            page.drawLine({ start: { x, y: y0 }, end: { x, y: y2 }, thickness: 1, color: rgb(0, 0, 0) });
        }

        for (const y of [y0, y1, y2]) {
            page.drawLine({ start: { x: x0, y }, end: { x: x2, y }, thickness: 1, color: rgb(0, 0, 0) });
        }

        drawPositionedTable(page, [60, 210], 568, [
            ["Name", "Preview"],
            ["Diagram", ""],
        ]);
        page.drawImage(image, { x: 235, y: 510, width: 48, height: 24 });
    });
}

async function buildMultiColumnFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Research Notes", { x: 210, y: 740, size: 22 });

        page.drawText("Left alpha opens the experiment.", { x: 60, y: 670, size: 12 });
        page.drawText("Left beta records the first state.", { x: 66, y: 646, size: 12 });
        page.drawText("Right alpha summarizes control.", { x: 340, y: 654, size: 12 });
        page.drawText("Right beta lists constraints.", { x: 346, y: 630, size: 12 });

        page.drawText("Shared note: both columns pause for this full-width update.", { x: 90, y: 590, size: 12 });

        page.drawText("Left gamma resumes below the note.", { x: 58, y: 548, size: 12 });
        page.drawText("Left delta closes the narrative.", { x: 64, y: 524, size: 12 });
        page.drawText("Right gamma resumes below the note.", { x: 338, y: 532, size: 12 });
        page.drawText("Right delta closes the appendix.", { x: 344, y: 508, size: 12 });
    });
}

async function buildReferenceListFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Reference Candidates", { x: 200, y: 740, size: 22 });
        drawPositionedTable(
            page,
            [50, 140],
            620,
            [
                ["Ref", "Source"],
                ["[1]", "Urban corridor baseline survey and calibration notes"],
                ["[2]", "Regional vibration review for mixed-use transport planning"],
                ["[3]", "Legacy monitoring appendix with maintenance history"],
                ["[4]", "Environmental screening digest for freight operations"],
            ],
            9,
            24
        );
    });
}

async function buildLeaderPatternFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Outline", { x: 240, y: 740, size: 22 });
        drawPositionedTable(
            page,
            [50, 280],
            620,
            [
                ["Overview ............", "1"],
                ["Methods .............", "5"],
                ["Results .............", "9"],
                ["Appendix ............", "14"],
            ],
            12,
            28
        );
    });
}

describe("PDFLoader", () => {
    beforeEach(() => {
        fullOCRPageOutputs = [];
        rasterizedPages = [new Uint8Array([1])];
        generateTextMock.mockClear();
        putNamedFileMock.mockClear();
        pdfToImgMock.mockClear();
    });

    test("returns plain text without image fences", async () => {
        const fixture = await buildLineTableFixture();

        expect(fixture.plain).toContain("Main Title");
        expect(fixture.plain).toContain("Alpha Omega");
        expect(fixture.plain).toContain("Name");
        expect(fixture.plain).not.toMatch(/:::IMG-img-1:::/);
        expect(fixture.plain).not.toContain("<image ");
    });

    test("returns hybrid markdown with headings tables and persisted image tags", async () => {
        const fixture = await buildLineTableFixture();

        expect(fixture.hybrid).toMatch(/^# Main Title$/m);
        expect(fixture.hybrid).toContain(
            '<image id="img-1" key="graphs/graph-1/derived/file-1/images/img-1.png">PDF figure summary</image>'
        );
        expect(fixture.hybrid).not.toMatch(/:::IMG-img-1:::/);
        expect(fixture.hybrid).toMatch(/\| Name \| Value \|/);
        expect(fixture.hybrid).toMatch(/\| Foo \| 42 \|/);
        expect(fixture.hybrid).toMatch(/\| Bar \| 84 \|/);
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(putNamedFileMock).toHaveBeenCalledTimes(1);
        expect(pdfToImgMock).not.toHaveBeenCalled();
    });

    test("detects aligned text tables as markdown in hybrid mode", async () => {
        const fixture = await buildAlignedTextTableFixture();

        expect(fixture.plain).toContain("Aligned Text Table");
        expect(fixture.hybrid).toMatch(/^# Aligned Text Table$/m);
        expect(fixture.hybrid).toMatch(/\| Item \| Weight \[kg\] \| Time \[ms\] \|/);
        expect(fixture.hybrid).toMatch(/\| Rotor \| 12 \| 30 \|/);
        expect(fixture.hybrid).toMatch(/\| Frame \| 24 \| 55 \|/);
    });

    test("preserves script-like math text and dedupes overprinted table chars", async () => {
        const fixture = await buildMathTableFixture();

        expect(fixture.hybrid).toMatch(/^# Math Table$/m);
        expect(fixture.hybrid).toMatch(/\| Expr \| Meaning \|/);
        expect(fixture.hybrid).not.toMatch(/Expr Expr/);
        expect(fixture.hybrid).toMatch(/\| x2 \| square \|/);
        expect(fixture.hybrid).toMatch(/\| H2O \| water \|/);
    });

    test("detects whitespace separated tables as markdown in hybrid mode", async () => {
        const fixture = await buildWhitespaceSeparatedTableFixture();

        expect(fixture.hybrid).toMatch(/^# Whitespace Segments$/m);
        expect(fixture.hybrid).toMatch(/\| City \| Score \| Rank \|/);
        expect(fixture.hybrid).toMatch(/\| Berlin \| 91 \| 1 \|/);
        expect(fixture.hybrid).toMatch(/\| Essen \| 77 \| 3 \|/);
    });

    test("reconstructs 90 and 270 degree text in plain and hybrid modes", async () => {
        const fixture = await buildRotatedTextFixture();

        expect(fixture.plain).toContain("Rotation Examples");
        expect(fixture.plain).toContain("Y Axis");
        expect(fixture.plain).toContain("Z Axis");
        expect(fixture.plain).not.toContain("s\ni\nx\nA");
        expect(fixture.plain).not.toContain("D\nE\nT\nA\nT\nO\nR");

        expect(fixture.hybrid).toMatch(/^# Rotation Examples$/m);
        expect(fixture.hybrid).toContain("Body text");
        expect(fixture.hybrid).toContain("Y Axis");
        expect(fixture.hybrid).toContain("Z Axis");
        expect(fixture.hybrid).not.toContain("s\ni\nx\nA");
    });

    test("extracts rotated table headers as normal markdown header cells", async () => {
        const fixture = await buildRotatedHeaderTableFixture();

        expect(fixture.hybrid).toMatch(/^# Rotated Headers$/m);
        expect(fixture.hybrid).toMatch(/\| Name \| Kind \| Value \|/);
        expect(fixture.hybrid).toMatch(/\| Rotor \| Part \| 12 \|/);
        expect(fixture.hybrid).toMatch(/\| Stator \| Part \| 18 \|/);
        expect(fixture.hybrid).not.toContain("e\nm\na\nN");
        expect(fixture.hybrid).not.toContain("d\nn\ni\nK");
    });

    test("uses adaptive boundaries for tracked prose, close words, identifiers, and formulas", async () => {
        const fixture = await buildAdaptiveBoundaryFixture();

        expect(fixture.plain).toContain("TrackedWord");
        expect(fixture.plain).toContain("Alpha Beta");
        expect(fixture.plain).toContain("api_v1/test.ts");
        expect(fixture.plain).toContain("H2SO4");
        expect(fixture.plain).toContain("f(x,y)=n+1");
        expect(fixture.plain).not.toContain("T r a c k e d");
        expect(fixture.plain).not.toContain("api _ v1 / test . ts");
        expect(fixture.plain).not.toContain("H 2 S O 4");

        expect(fixture.hybrid).toMatch(/^# Adaptive Boundaries$/m);
        expect(fixture.hybrid).toContain("TrackedWord");
        expect(fixture.hybrid).toContain("Alpha Beta");
        expect(fixture.hybrid).toContain("api_v1/test.ts");
        expect(fixture.hybrid).toContain("H2SO4");
        expect(fixture.hybrid).toContain("f(x,y)=n+1");
    });

    test("detects whitespace tables without splitting tracked identifiers and formulas", async () => {
        const fixture = await buildAdaptiveWhitespaceTableFixture();

        expect(fixture.hybrid).toMatch(/^# Adaptive Table$/m);
        expect(fixture.hybrid).toMatch(/\| Key \| Formula \| Value \|/);
        expect(fixture.hybrid).toMatch(/\| api_v1 \| H2SO4 \| 42 \|/);
        expect(fixture.hybrid).toMatch(/\| file.ts \| f\(x,y\) \| 17 \|/);
        expect(fixture.hybrid).not.toContain("api _ v1");
        expect(fixture.hybrid).not.toContain("H 2 S O 4");
    });

    test("uses inline ActualText for tagged prose in plain and hybrid modes", async () => {
        const fixture = await buildTaggedActualTextFixture();

        expect(fixture.plain).toContain("Tagged Math");
        expect(fixture.plain).toContain("Visible: x squared done");
        expect(fixture.plain).not.toContain("Visible: x done");

        expect(fixture.hybrid).toMatch(/^#{1,2} Tagged Math$/m);
        expect(fixture.hybrid).toContain("Visible: x squared done");
        expect(fixture.hybrid).not.toContain("Visible: x done");
    });

    test("uses named marked-content properties and UTF-16 ActualText inside detected tables", async () => {
        const fixture = await buildTaggedTableFixture();

        expect(fixture.plain).toContain("Tagged Table");
        expect(fixture.hybrid).toMatch(/^# Tagged Table$/m);
        expect(fixture.hybrid).toMatch(/\| Expr \| Meaning \|/);
        expect(fixture.hybrid).toMatch(/\| x\^2 \| square \|/);
        expect(fixture.hybrid).toMatch(/\| n \| count \|/);
        expect(fixture.hybrid).not.toMatch(/\| x \| square \|/);
    });

    test("suppresses repeated headers and numbered footers across multiple pages in hybrid mode", async () => {
        const fixture = await buildRepeatedEdgeFixture();

        expect(fixture.plain).toContain("Quarterly Status Report");
        expect(fixture.plain).toContain("Page 1");
        expect(fixture.plain).toContain("Page 2");
        expect(fixture.hybrid).toContain("Section 1");
        expect(fixture.hybrid).toContain("Section 2");
        expect(fixture.hybrid).toContain("Section 3");
        expect(fixture.hybrid).not.toContain("Quarterly Status Report");
        expect(fixture.hybrid).not.toContain("Page 1");
        expect(fixture.hybrid).not.toContain("Page 2");
        expect(fixture.hybrid).not.toContain("Page 3");
    });

    test("applies adjacent ActualText spans independently on the same line", async () => {
        const fixture = await buildTaggedAdjacentActualTextFixture();

        expect(fixture.plain).toContain("Formula: x^2+y^2");
        expect(fixture.plain).not.toContain("Formula: x+y");
        expect(fixture.hybrid).toMatch(/^#{1,2} Adjacent Tags$/m);
        expect(fixture.hybrid).toContain("Formula: x^2+y^2");
        expect(fixture.hybrid).not.toContain("Formula: x+y");
    });

    test("ignores images embedded inside detected tables instead of emitting broken image fences", async () => {
        const fixture = await buildTableWithEmbeddedImageFixture();

        expect(fixture.hybrid).toMatch(/^# Image In Table$/m);
        expect(fixture.hybrid).toContain("Preview");
        expect(fixture.hybrid).toContain("Diagram");
        expect(fixture.hybrid).not.toContain("<image id=");
        expect(fixture.hybrid).not.toContain(":::IMG-");
        expect(generateTextMock).not.toHaveBeenCalled();
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("keeps two-column reading order with a full-width note between column sections", async () => {
        const fixture = await buildMultiColumnFixture();

        const plainLeftTop = fixture.plain.indexOf("Left alpha opens the experiment.");
        const plainLeftSecond = fixture.plain.indexOf("Left beta records the first state.");
        const plainRightTop = fixture.plain.indexOf("Right alpha summarizes control.");
        const plainNote = fixture.plain.indexOf("Shared note: both columns pause for this full-width update.");
        const plainLeftBottom = fixture.plain.indexOf("Left gamma resumes below the note.");
        const plainLeftBottomSecond = fixture.plain.indexOf("Left delta closes the narrative.");
        const plainRightBottom = fixture.plain.indexOf("Right gamma resumes below the note.");

        expect(plainLeftTop).toBeGreaterThan(-1);
        expect(plainLeftSecond).toBeGreaterThan(plainLeftTop);
        expect(plainRightTop).toBeGreaterThan(plainLeftSecond);
        expect(plainNote).toBeGreaterThan(plainRightTop);
        expect(plainLeftBottom).toBeGreaterThan(plainNote);
        expect(plainLeftBottomSecond).toBeGreaterThan(plainLeftBottom);
        expect(plainRightBottom).toBeGreaterThan(plainLeftBottomSecond);

        expect(fixture.hybrid).toMatch(/^# Research Notes$/m);
        const hybridLeftTop = fixture.hybrid.indexOf("Left alpha opens the experiment.");
        const hybridLeftSecond = fixture.hybrid.indexOf("Left beta records the first state.");
        const hybridRightTop = fixture.hybrid.indexOf("Right alpha summarizes control.");
        const hybridNote = fixture.hybrid.indexOf("Shared note: both columns pause for this full-width update.");
        const hybridLeftBottom = fixture.hybrid.indexOf("Left gamma resumes below the note.");
        const hybridLeftBottomSecond = fixture.hybrid.indexOf("Left delta closes the narrative.");
        const hybridRightBottom = fixture.hybrid.indexOf("Right gamma resumes below the note.");

        expect(hybridLeftTop).toBeGreaterThan(-1);
        expect(hybridLeftSecond).toBeGreaterThan(hybridLeftTop);
        expect(hybridRightTop).toBeGreaterThan(hybridLeftSecond);
        expect(hybridNote).toBeGreaterThan(hybridRightTop);
        expect(hybridLeftBottom).toBeGreaterThan(hybridNote);
        expect(hybridLeftBottomSecond).toBeGreaterThan(hybridLeftBottom);
        expect(hybridRightBottom).toBeGreaterThan(hybridLeftBottomSecond);
        expect(fixture.hybrid).not.toMatch(/^\| .+\|$/m);
    });

    test("keeps reference-like tables as prose in hybrid mode", async () => {
        const fixture = await buildReferenceListFixture();

        expect(fixture.hybrid).toMatch(/^# Reference Candidates$/m);
        expect(fixture.hybrid).toContain("[1]");
        expect(fixture.hybrid).toContain("Urban corridor baseline survey and calibration notes");
        expect(fixture.hybrid).not.toMatch(/^\| .*\|$/m);
    });

    test("keeps leader patterns as prose in hybrid mode", async () => {
        const fixture = await buildLeaderPatternFixture();

        expect(fixture.hybrid).toMatch(/^# Outline$/m);
        expect(fixture.hybrid).toContain("Overview ............");
        expect(fixture.hybrid).not.toMatch(/^\| .*\|$/m);
    });

    test("transcribes rasterized pages in full OCR mode and preserves page order", async () => {
        const loader = {
            getText: async () => "",
            getBinary: async () => new Uint8Array([1, 2, 3]).buffer,
        };
        rasterizedPages = [new Uint8Array([1]), new Uint8Array([2])];
        fullOCRPageOutputs = ["# Page 1\nAlpha", "## Page 2\n<image>Diagram</image>"];

        const text = await new PDFLoader({
            loader,
            mode: "ocr",
            model: {} as never,
        }).getText();

        expect(text).toBe("# Page 1\nAlpha\n\n## Page 2\n<image>Diagram</image>");
        expect(pdfToImgMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock).toHaveBeenCalledTimes(2);
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("throws when full OCR mode is missing a model", async () => {
        const loader = {
            getText: async () => "",
            getBinary: async () => new Uint8Array([1]).buffer,
        };

        await expect(
            new PDFLoader({
                loader,
                mode: "ocr",
            }).getText()
        ).rejects.toThrow("PDF full OCR requires an image-capable model");
    });

    test("throws when hybrid mode is missing storage", async () => {
        const loader = {
            getText: async () => "",
            getBinary: async () => new Uint8Array([1]).buffer,
        };

        await expect(
            new PDFLoader({
                loader,
                mode: "hybrid",
                model: {} as never,
            }).getText()
        ).rejects.toThrow("PDF hybrid mode requires an image model and storage configuration");
    });
});
