import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PDF, degrees, measureText, rgb } from "@libpdf/core";
import { transcribePrompt } from "@kiwi/ai/prompts/transcribe.prompt";
import { EventEmitter } from "node:events";
import { inflateSync } from "node:zlib";

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

const putNamedFileMock = mock((name: string, _file: Uint8Array, path: string) =>
    Effect.succeed({
        key: `${path}/${name}`,
        type: "image/png",
    })
);

function createProcessStream() {
    const stream = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
    stream.setEncoding = () => {};
    return stream;
}

const ghostscriptSpawnMock = mock(() => {
    const child = new EventEmitter() as EventEmitter & {
        stdout: ReturnType<typeof createProcessStream>;
        stderr: ReturnType<typeof createProcessStream>;
    };
    child.stdout = createProcessStream();
    child.stderr = createProcessStream();

    queueMicrotask(() => {
        const error = new Error("Ghostscript is not available") as Error & { code: string };
        error.code = "ENOENT";
        child.emit("error", error);
    });

    return child;
});

const pdfToImgMock = mock(async (_content: Buffer, _options?: { scale?: number }) => {
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
    FileStorageLive: Layer.empty,
    PDF_PREVIEW_SCALE: 1.5,
}));

mock.module("node:child_process", () => ({
    spawn: ghostscriptSpawnMock,
}));

mock.module("pdf-to-img", () => ({
    pdf: pdfToImgMock,
}));

const { PDFLoader } = await import("../pdf.ts");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6rmS0AAAAASUVORK5CYII=";
const AWIFOE_RAW_IMAGE_BASE64 = "eJztwTEBAAAAwqD1T20Hb6AAAAAAAAAAAAAAAAAAAAB+Azy0AAE=";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

function drawCompactWordLine(
    page: ReturnType<PDF["addPage"]>,
    words: string[],
    x: number,
    y: number,
    size = 9.5,
    wordGap = 2.3,
    font: Parameters<typeof measureText>[1] = "Helvetica"
): void {
    let cursor = x;
    for (const word of words) {
        page.drawText(word, { x: cursor, y, size, font });
        cursor += measureText(word, font, size) + wordGap;
    }
}

async function buildPDFBinary(build: (pdf: PDF) => Promise<void> | void): Promise<Uint8Array> {
    const pdf = PDF.create();
    await build(pdf);
    return await pdf.save();
}

type TestPDFTableMode = "lines" | "lines_strict";

async function buildHybridFixture(
    build: (pdf: PDF) => Promise<void> | void,
    options: { tableMode?: TestPDFTableMode } = {}
): Promise<{
    plain: string;
    hybrid: string;
}> {
    const bytes = await buildPDFBinary(build);
    return buildHybridFixtureFromBytes(bytes, options);
}

async function buildHybridFixtureFromBytes(
    bytes: Uint8Array,
    options: { tableMode?: TestPDFTableMode } = {}
): Promise<{
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
        tableMode: options.tableMode,
        model: {} as never,
        storage: { bucket: "bucket", imagePrefix: "graphs/graph-1/file-1.pdf/file-1/images" },
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

function isPNG(bytes: Uint8Array): boolean {
    return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function getGeneratedImageBytes(callIndex = 0): Uint8Array {
    const message = generateTextMock.mock.calls[callIndex]?.[0]?.messages?.[0];
    const image = Array.isArray(message?.content) ? message.content.find((part) => part.type === "image")?.image : null;
    if (typeof image !== "string") {
        return new Uint8Array();
    }

    return Uint8Array.from(Buffer.from(image.split(",")[1] ?? "", "base64"));
}

async function buildLineTableFixture() {
    return buildHybridFixture(buildLineTablePDF);
}

async function buildLineTableFixtureBytes() {
    return buildPDFBinary(buildLineTablePDF);
}

async function buildLineTablePDF(pdf: PDF) {
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
}

async function buildCurvePathTableFixture(options: { tableMode?: TestPDFTableMode } = {}) {
    const content = Buffer.from(
        [
            "BT /F1 22 Tf 205 740 Td (Curve Path Table) Tj ET",
            "BT /F1 12 Tf 60 585 Td (Name) Tj ET",
            "BT /F1 12 Tf 180 585 Td (Value) Tj ET",
            "BT /F1 12 Tf 60 557 Td (Foo) Tj ET",
            "BT /F1 12 Tf 180 557 Td (42) Tj ET",
            "BT /F1 12 Tf 60 529 Td (Bar) Tj ET",
            "BT /F1 12 Tf 180 529 Td (84) Tj ET",
            "1 w",
            "50 520 m",
            "290 520 l",
            "290 604 l",
            "50 604 l",
            "h",
            "170 520 m 170 548 170 576 170 604 c",
            "50 548 m 130 548 290 548 v",
            "50 576 m 130 576 290 576 y",
            "S",
        ].join("\n"),
        "latin1"
    );
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        pdfStream(`<< /Length ${content.length} >>`, content),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];

    return buildHybridFixtureFromBytes(buildPDF(objects), options);
}

async function buildRectanglePathTableFixture(options: { tableMode?: TestPDFTableMode } = {}) {
    const content = Buffer.from(
        [
            "BT /F1 22 Tf 190 740 Td (Rectangle Path Grid) Tj ET",
            "BT /F1 12 Tf 60 585 Td (Name) Tj ET",
            "BT /F1 12 Tf 180 585 Td (Value) Tj ET",
            "BT /F1 12 Tf 60 557 Td (Foo) Tj ET",
            "BT /F1 12 Tf 180 557 Td (42) Tj ET",
            "BT /F1 12 Tf 60 529 Td (Bar) Tj ET",
            "BT /F1 12 Tf 180 529 Td (84) Tj ET",
            "1 w",
            "50 576 120 28 re",
            "170 576 120 28 re",
            "50 548 120 28 re",
            "170 548 120 28 re",
            "50 520 120 28 re",
            "170 520 120 28 re",
            "S",
        ].join("\n"),
        "latin1"
    );
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        pdfStream(`<< /Length ${content.length} >>`, content),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];

    return buildHybridFixtureFromBytes(buildPDF(objects), options);
}

async function buildImplicitClosePathTableFixture() {
    const content = Buffer.from(
        [
            "BT /F1 22 Tf 175 740 Td (Implicit Close Grid) Tj ET",
            "BT /F1 12 Tf 60 585 Td (Name) Tj ET",
            "BT /F1 12 Tf 180 585 Td (Value) Tj ET",
            "BT /F1 12 Tf 60 557 Td (Foo) Tj ET",
            "BT /F1 12 Tf 180 557 Td (42) Tj ET",
            "1 w",
            "50 548 m",
            "290 548 l",
            "290 604 l",
            "50 604 l",
            "s",
            "170 548 m 170 604 l",
            "50 576 m 290 576 l",
            "S",
        ].join("\n"),
        "latin1"
    );
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        pdfStream(`<< /Length ${content.length} >>`, content),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];

    return buildHybridFixtureFromBytes(buildPDF(objects));
}

function buildRawFlateImagePDF(): Uint8Array {
    const rawImage = Buffer.from(AWIFOE_RAW_IMAGE_BASE64, "base64");
    const content = Buffer.from(
        ["BT /F1 18 Tf 50 700 Td (Raw PDF Image) Tj ET", "q", "140 0 0 37 50 600 cm", "/ImRaw Do", "Q"].join("\n"),
        "latin1"
    );
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 800] /Resources << /Font << /F1 6 0 R >> /XObject << /ImRaw 5 0 R >> >> /Contents 4 0 R >>",
        pdfStream(`<< /Length ${content.length} >>`, content),
        pdfStream(
            "<< /Type /XObject /Subtype /Image /Width 140 /Height 37 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 38 >>",
            rawImage
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];

    return buildPDF(objects);
}

function buildRawCMYKImagePDF(): Uint8Array {
    const rawImage = Buffer.from([0x78, 0x9c, 0x6b, 0x68, 0x68, 0x68, 0x00, 0x00, 0x03, 0x05, 0x02, 0x01]);
    const content = Buffer.from(["q", "1 0 0 1 50 600 cm", "/ImRaw Do", "Q"].join("\n"), "latin1");
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /ImRaw 5 0 R >> >> /Contents 4 0 R >>",
        pdfStream(`<< /Length ${content.length} >>`, content),
        pdfStream(
            `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode /Length ${rawImage.length} >>`,
            rawImage
        ),
        "<< >>",
    ];

    return buildPDF(objects);
}

function buildAsciiHexJPEGImagePDF(): Uint8Array {
    const jpegHex = Buffer.from("FFD8FFE000104A46494600010100000100010000FFDB>", "latin1");
    const content = Buffer.from(["q", "1 0 0 1 50 600 cm", "/ImRaw Do", "Q"].join("\n"), "latin1");
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /ImRaw 5 0 R >> >> /Contents 4 0 R >>",
        pdfStream(`<< /Length ${content.length} >>`, content),
        pdfStream(
            `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${jpegHex.length} >>`,
            jpegHex
        ),
        "<< >>",
    ];

    return buildPDF(objects);
}

function readFirstPNGPixel(png: Uint8Array): [number, number, number] {
    const chunks = readPNGChunks(png);
    const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => Buffer.from(chunk.data)));
    const scanline = inflateSync(idat);

    return [scanline[1]!, scanline[2]!, scanline[3]!];
}

function isJPEG(bytes: Uint8Array): boolean {
    return bytes[0] === 0xff && bytes[1] === 0xd8;
}

function readPNGChunks(png: Uint8Array): Array<{ type: string; data: Uint8Array }> {
    const chunks: Array<{ type: string; data: Uint8Array }> = [];
    let offset = 8;

    while (offset + 8 <= png.length) {
        const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
        const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString("latin1");
        const data = png.subarray(offset + 8, offset + 8 + length);
        chunks.push({ type, data });
        offset += 12 + length;
    }

    return chunks;
}

function pdfStream(dictionary: string, content: Buffer): Buffer {
    return Buffer.concat([
        Buffer.from(`${dictionary}\nstream\n`, "latin1"),
        content,
        Buffer.from("\nendstream", "latin1"),
    ]);
}

function buildPDF(objects: Array<string | Buffer>): Uint8Array {
    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
    const offsets = [0];
    let length = chunks[0]!.length;

    objects.forEach((object, index) => {
        const objectHeader = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
        const objectBody = typeof object === "string" ? Buffer.from(object, "latin1") : object;
        const objectFooter = Buffer.from("\nendobj\n", "latin1");

        offsets.push(length);
        chunks.push(objectHeader, objectBody, objectFooter);
        length += objectHeader.length + objectBody.length + objectFooter.length;
    });

    const xrefOffset = length;
    chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, "latin1"));
    for (const offset of offsets.slice(1)) {
        chunks.push(Buffer.from(`${offset.toString().padStart(10, "0")} 00000 n \n`, "latin1"));
    }

    chunks.push(
        Buffer.from(
            `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
            "latin1"
        )
    );

    return Uint8Array.from(Buffer.concat(chunks));
}

async function buildAlignedTextTableFixture() {
    return buildHybridFixture(
        (pdf) => {
            const page = pdf.addPage({ size: "letter" });

            page.drawText("Aligned Text Table", { x: 210, y: 740, size: 22 });
            drawPositionedTable(page, [50, 180, 320], 620, [
                ["Item", "Weight", "Time"],
                ["", "[kg]", "[ms]"],
                ["Rotor", "12", "30"],
                ["Stator", "18", "41"],
                ["Frame", "24", "55"],
            ]);
        },
        { tableMode: "lines" }
    );
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

async function buildWhitespaceSeparatedTableFixture(
    options: { tableMode?: TestPDFTableMode } = { tableMode: "lines" }
) {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Whitespace Segments", { x: 210, y: 740, size: 22 });
        drawLineRows(page, 50, 620, [
            "City          Score          Rank",
            "Berlin        91             1",
            "Leipzig       84             2",
            "Essen         77             3",
        ]);
    }, options);
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
        drawTrackedText(page, "TrackedWord", 60, 660, 12, 1.2);
        page.drawText("Alpha", { x: 60, y: 628, size: 12 });
        page.drawText("Beta", { x: 104, y: 628, size: 12 });
        drawTrackedText(page, "api_v1/test.ts", 60, 596, 12, 1.2);
        drawTrackedText(page, "H2SO4", 60, 564, 12, 1.2);
        drawTrackedText(page, "f(x,y)=n+1", 60, 532, 12, 1.2);
    });
}

async function buildCompactWordGapFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "a4" });

        drawCompactWordLine(page, ["GENERIC", "ALPHA", "Boundary", "Fixture"], 56, 760, 18.9, 4.9);
        drawCompactWordLine(
            page,
            ["This", "synthetic", "line", "is", "intended", "to", "test", "compact", "generic", "tokens", "-"],
            56,
            556
        );
        drawCompactWordLine(
            page,
            ["continued,", "without", "joining", "the", "neighboring", "same", "baseline"],
            305,
            556
        );
        drawCompactWordLine(page, ["A", "nearby", "column", "stays", "separate"], 305, 568);
        drawTrackedText(page, "TrackedWord", 56, 520, 12, 1.2);
        drawTrackedText(page, "api_v1/test.ts", 56, 496, 12, 1.2);
    });
}

async function buildAdaptiveWhitespaceTableFixture() {
    return buildHybridFixture(
        (pdf) => {
            const page = pdf.addPage({ size: "letter" });

            page.drawText("Adaptive Table", { x: 205, y: 740, size: 22 });

            const rows = [
                ["Key", "Formula", "Value"],
                ["api_v1", "H2SO4", "42"],
                ["file.ts", "f(x,y)", "17"],
            ];

            rows.forEach((row, rowIndex) => {
                const y = 620 - rowIndex * 28;
                drawTrackedText(page, row[0]!, 50, y, 12, rowIndex === 0 ? 0 : 1.2);
                drawTrackedText(page, row[1]!, 190, y, 12, rowIndex === 0 ? 0 : 1.2);
                page.drawText(row[2]!, { x: 330, y, size: 12 });
            });
        },
        { tableMode: "lines" }
    );
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

async function buildLatin1ActualTextFixture() {
    const bytes = await buildPDFBinary((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Latin1 Tag", { x: 220, y: 740, size: 22 });
        page.drawText("Word:", { x: 60, y: 640, size: 12 });
        page.drawText("x", { x: 100, y: 640, size: 12 });
    });

    const actualText = `caf${String.fromCharCode(0xe9)}`;
    const patched = patchContentStreams(bytes, (stream) => {
        return stream.replace(/<78> Tj/, `/Span << /ActualText (${actualText}) /MCID 0 >> BDC\n<78> Tj\nEMC`);
    });

    return buildHybridFixtureFromBytes(patched);
}

async function buildControlActualTextFixture() {
    const bytes = await buildPDFBinary((pdf) => {
        const page = pdf.addPage({ size: "letter" });

        page.drawText("Control Tag", { x: 220, y: 740, size: 22 });
        page.drawText("x", { x: 60, y: 640, size: 12 });
    });

    const patched = patchContentStreams(bytes, (stream) => {
        return stream.replace(
            /<78> Tj/,
            `/Span << /ActualText <${encodeUtf16BEHex("Label\b Page")}> /MCID 0 >> BDC\n<78> Tj\nEMC`
        );
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

async function buildNarrowGutterColumnFixture() {
    return buildHybridFixture((pdf) => {
        const page = pdf.addPage({ size: "a4" });

        page.drawText("Narrow Gutter Report", { x: 56, y: 780, size: 18 });

        page.drawText("RIGHT SECTION", { x: 305, y: 730, size: 12 });
        drawLineRows(page, 305, 708, [
            "Right alpha starts high.",
            "Right beta continues high.",
            "Right gamma keeps the second column active.",
            "Right delta overlaps the first column vertically.",
            "Right epsilon closes after the left column begins.",
            "Right zeta remains parallel to the left column.",
            "Right eta remains parallel to the left column.",
            "Right theta remains parallel to the left column.",
            "Right iota remains parallel to the left column.",
            "Right kappa closes after the left column begins.",
        ]);

        page.drawText("LEFT SECTION", { x: 56, y: 520, size: 12 });
        drawLineRows(page, 56, 498, [
            "Left alpha before right.",
            "Left beta first column.",
            "Left gamma first column.",
        ]);

        page.drawText("FULL WIDTH NEXT", { x: 56, y: 360, size: 12 });
        page.drawText("Full width body resumes after both columns and spans the entire page.", {
            x: 56,
            y: 338,
            size: 12,
        });
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
        ghostscriptSpawnMock.mockClear();
        pdfToImgMock.mockClear();
    });

    test("returns plain text without image fences", async () => {
        const fixture = await buildLineTableFixture();

        expect(fixture.plain).toMatch(/^:::PAGE-1:::$/m);
        expect(fixture.plain).toContain("Main Title");
        expect(fixture.plain).toContain("Alpha Omega");
        expect(fixture.plain).toContain("Name");
        expect(fixture.plain).not.toMatch(/:::IMG-img-1:::/);
        expect(fixture.plain).not.toContain("<image ");
    });

    test("returns hybrid markdown with headings tables and PDF image tags", async () => {
        const fixture = await buildLineTableFixture();

        expect(fixture.hybrid).toMatch(/^:::PAGE-1:::$/m);
        expect(fixture.hybrid).toMatch(/^# Main Title$/m);
        expect(fixture.hybrid).toContain('<image id="img-1">PDF figure summary</image>');
        expect(fixture.hybrid).not.toMatch(/:::IMG-img-1:::/);
        expect(fixture.hybrid).toMatch(/\| Name \| Value \|/);
        expect(fixture.hybrid).toMatch(/\| Foo \| 42 \|/);
        expect(fixture.hybrid).toMatch(/\| Bar \| 84 \|/);
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(putNamedFileMock).not.toHaveBeenCalled();
        expect(pdfToImgMock).not.toHaveBeenCalled();
    });

    test("returns coordinate-backed PDF source chunks without chunk markers", async () => {
        const bytes = await buildLineTableFixtureBytes();
        const loader = {
            getText: async () => Buffer.from(bytes).toString(),
            getBinary: async () => bytes.slice().buffer,
        };

        const document = await new PDFLoader({
            loader,
            mode: "hybrid",
            model: {} as never,
            storage: { bucket: "bucket", imagePrefix: "graphs/graph-1/file-1.pdf/file-1/images" },
        }).getDocument();

        expect(document.text).toContain('<image id="img-1">PDF figure summary</image>');
        expect(document.text).not.toContain(":::CHUNK-");
        expect(
            document.sourceChunks?.some((chunk) => chunk.type === "text" && chunk.regions?.[0]?.kind === "text")
        ).toBe(true);
        expect(document.sourceChunks).toContainEqual(
            expect.objectContaining({
                type: "image",
                text: "PDF figure summary",
                imageId: "img-1",
                imageKey: null,
                regions: [expect.objectContaining({ kind: "image", page: 1 })],
            })
        );
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("uses full-page OCR for fragmented hybrid pages", async () => {
        const bytes = await buildPDFBinary((pdf) => {
            const page = pdf.addPage({ size: "letter" });
            for (let index = 0; index < 40; index += 1) {
                page.drawText(`Marker${index.toString().padStart(2, "0")}`, {
                    x: 40 + (index % 7) * 71,
                    y: 750 - index * 16,
                    size: 8,
                });
            }
        });
        const loader = {
            getText: async () => Buffer.from(bytes).toString(),
            getBinary: async () => bytes.slice().buffer,
        };
        rasterizedPages = [new Uint8Array([9])];
        fullOCRPageOutputs = ["# OCR fallback\nReadable page text"];

        const text = await new PDFLoader({
            loader,
            mode: "hybrid",
            model: {} as never,
            storage: { bucket: "bucket", imagePrefix: "graphs/graph-1/file-1.pdf/file-1/images" },
        }).getText();

        expect(text).toBe(":::PAGE-1:::\n\n# OCR fallback\nReadable page text");
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock.mock.calls[0]?.[0]).toMatchObject({ system: transcribePrompt });
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("falls back to full OCR when hybrid extraction finds no readable text", async () => {
        const bytes = await buildPDFBinary((pdf) => {
            const page = pdf.addPage({ size: "letter" });
            page.drawLine({ start: { x: 60, y: 640 }, end: { x: 520, y: 640 }, thickness: 2, color: rgb(0, 0, 0) });
            page.drawLine({ start: { x: 60, y: 600 }, end: { x: 520, y: 600 }, thickness: 2, color: rgb(0, 0, 0) });
        });
        const loader = {
            getText: async () => "",
            getBinary: async () => bytes.slice().buffer,
        };
        rasterizedPages = [new Uint8Array([7])];
        fullOCRPageOutputs = ["Fallback OCR found the general sentence."];

        const text = await new PDFLoader({
            loader,
            mode: "hybrid",
            model: {} as never,
            storage: { bucket: "bucket", imagePrefix: "graphs/graph-1/file-1.pdf/file-1/images" },
        }).getText();

        expect(text).toBe(":::PAGE-1:::\n\nFallback OCR found the general sentence.");
        expect(pdfToImgMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock.mock.calls[0]?.[0]).toMatchObject({ system: transcribePrompt });
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("detects curve-derived grids in loose pdfplumber lines table mode", async () => {
        const fixture = await buildCurvePathTableFixture({ tableMode: "lines" });

        expect(fixture.plain).toContain("Curve Path Table");
        expect(fixture.hybrid).toMatch(/^# Curve Path Table$/m);
        expect(fixture.hybrid).toMatch(/\| Name \| Value \|/);
        expect(fixture.hybrid).toMatch(/\| Foo \| 42 \|/);
        expect(fixture.hybrid).toMatch(/\| Bar \| 84 \|/);
    });

    test("detects rectangle-derived grids in loose pdfplumber lines table mode", async () => {
        const fixture = await buildRectanglePathTableFixture({ tableMode: "lines" });

        expect(fixture.plain).toContain("Rectangle Path Grid");
        expect(fixture.hybrid).toMatch(/^# Rectangle Path Grid$/m);
        expect(fixture.hybrid).toMatch(/\| Name \| Value \|/);
        expect(fixture.hybrid).toMatch(/\| Foo \| 42 \|/);
        expect(fixture.hybrid).toMatch(/\| Bar \| 84 \|/);
    });

    test("detects grids closed by implicit PDF path painting operators", async () => {
        const fixture = await buildImplicitClosePathTableFixture();

        expect(fixture.plain).toContain("Implicit Close Grid");
        expect(fixture.hybrid).toMatch(/^# Implicit Close Grid$/m);
        expect(fixture.hybrid).toMatch(/\| Name \| Value \|/);
        expect(fixture.hybrid).toMatch(/\| Foo \| 42 \|/);
    });

    test("excludes curve-derived grids by default in lines_strict table mode", async () => {
        const fixture = await buildCurvePathTableFixture();

        expect(fixture.hybrid).toMatch(/^# Curve Path Table$/m);
        expect(fixture.hybrid).toContain("Name Value");
        expect(fixture.hybrid).not.toMatch(/^\| .+\|$/m);
    });

    test("excludes rectangle-derived grids by default in lines_strict table mode", async () => {
        const fixture = await buildRectanglePathTableFixture();

        expect(fixture.hybrid).toMatch(/^# Rectangle Path Grid$/m);
        expect(fixture.hybrid).toContain("Name Value");
        expect(fixture.hybrid).not.toMatch(/^\| .+\|$/m);
    });

    test("converts a raw FlateDecode image stream from the AWiFoe PDF into a PNG", async () => {
        const fixture = await buildHybridFixtureFromBytes(buildRawFlateImagePDF());

        expect(fixture.hybrid).toMatch(/^Raw PDF Image$/m);
        expect(fixture.hybrid).toContain('<image id="img-1">PDF figure summary</image>');
        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(putNamedFileMock).not.toHaveBeenCalled();
        expect(isPNG(Buffer.from(AWIFOE_RAW_IMAGE_BASE64, "base64"))).toBe(false);
    });

    test("converts raw CMYK image samples to RGB without additive black clipping", async () => {
        await buildHybridFixtureFromBytes(buildRawCMYKImagePDF());

        expect(putNamedFileMock).not.toHaveBeenCalled();
        expect(readFirstPNGPixel(getGeneratedImageBytes())).toEqual([63, 63, 63]);
    });

    test("decodes filters before DCTDecode instead of uploading encoded wrapper bytes", async () => {
        await buildHybridFixtureFromBytes(buildAsciiHexJPEGImagePDF());

        expect(putNamedFileMock).not.toHaveBeenCalled();
        expect(isJPEG(getGeneratedImageBytes())).toBe(true);
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

        expect(fixture.plain).toContain("x2 square");
        expect(fixture.plain).toContain("H2O water");
        expect(fixture.plain).not.toContain("H O water");

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

    test("detects whitespace separated tables in default strict-line mode", async () => {
        const fixture = await buildWhitespaceSeparatedTableFixture({});

        expect(fixture.hybrid).toMatch(/\| City \| Score \| Rank \|/);
        expect(fixture.hybrid).toMatch(/\| Leipzig \| 84 \| 2 \|/);
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

    test("infers compact word gaps without joining same-baseline columns", async () => {
        const fixture = await buildCompactWordGapFixture();

        expect(fixture.hybrid).toContain("GENERIC ALPHA Boundary Fixture");
        expect(fixture.hybrid).toContain("This synthetic line is intended to test compact generic tokens -");
        expect(fixture.hybrid).toContain("continued, without joining the neighboring same baseline");
        expect(fixture.hybrid).not.toContain("GENERICALPHABoundaryFixture");
        expect(fixture.hybrid).not.toContain("tokens - continued, without");
        expect(fixture.hybrid).toContain("TrackedWord");
        expect(fixture.hybrid).toContain("api_v1/test.ts");
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

    test("decodes raw Latin-1 bytes in ActualText literal strings", async () => {
        const fixture = await buildLatin1ActualTextFixture();
        const actualText = `caf${String.fromCharCode(0xe9)}`;

        expect(fixture.plain).toContain(`Word: ${actualText}`);
        expect(fixture.plain).not.toContain("caf\uFFFD");
        expect(fixture.hybrid).toContain(`Word: ${actualText}`);
    });

    test("cleans control characters from UTF-16 ActualText", async () => {
        const fixture = await buildControlActualTextFixture();

        expect(fixture.plain).toContain("Label Page");
        expect(fixture.plain).not.toContain("\b");
        expect(fixture.hybrid).toContain("Label Page");
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

    test("keeps narrow-gutter two-column sections in column order", async () => {
        const fixture = await buildNarrowGutterColumnFixture();

        const left = fixture.hybrid.indexOf("Left alpha before right.");
        const right = fixture.hybrid.indexOf("Right alpha starts high.");
        const next = fixture.hybrid.indexOf("FULL WIDTH NEXT");

        expect(fixture.hybrid).toMatch(/^# Narrow Gutter Report$/m);
        expect(left).toBeGreaterThan(-1);
        expect(right).toBeGreaterThan(left);
        expect(next).toBeGreaterThan(right);
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
        const bytes = await buildPDFBinary((pdf) => {
            pdf.addPage({ size: "letter" });
            pdf.addPage({ size: "letter" });
        });
        const loader = {
            getText: async () => "",
            getBinary: async () => bytes.slice().buffer,
        };
        rasterizedPages = [new Uint8Array([1]), new Uint8Array([2])];
        fullOCRPageOutputs = ["# Page 1\nAlpha", "## Page 2\n<image>Diagram</image>"];

        const text = await new PDFLoader({
            loader,
            mode: "ocr",
            model: {} as never,
        }).getText();

        expect(text).toBe(":::PAGE-1:::\n\n# Page 1\nAlpha\n\n:::PAGE-2:::\n\n## Page 2\n<image>Diagram</image>");
        expect(pdfToImgMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock).toHaveBeenCalledTimes(2);
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("splits full OCR pages into smaller page-region source chunks", async () => {
        const bytes = await buildPDFBinary((pdf) => {
            pdf.addPage({ size: "letter" });
        });
        const loader = {
            getText: async () => "",
            getBinary: async () => bytes.slice().buffer,
        };
        rasterizedPages = [new Uint8Array([1])];
        fullOCRPageOutputs = [Array.from({ length: 260 }, (_, index) => `word${index}`).join(" ")];

        const document = await new PDFLoader({
            loader,
            mode: "ocr",
            model: {} as never,
        }).getDocument();

        expect(document.sourceChunks?.length).toBeGreaterThan(1);
        expect(document.sourceChunks?.every((chunk) => chunk.regions?.[0]?.kind === "page")).toBe(true);
        expect(document.sourceChunks?.map((chunk) => chunk.text).join(" ")).toContain("word259");
    });

    test("scales oversized pages to 0.75 for full OCR rasterization", async () => {
        const bytes = await buildPDFBinary((pdf) => {
            pdf.addPage({ width: 1190.56, height: 1683.78 });
        });
        const loader = {
            getText: async () => "",
            getBinary: async () => bytes.slice().buffer,
        };
        rasterizedPages = [new Uint8Array([1])];
        fullOCRPageOutputs = ["# Oversized"];

        await new PDFLoader({
            loader,
            mode: "ocr",
            model: {} as never,
        }).getText();

        expect(pdfToImgMock).toHaveBeenCalledTimes(1);
        expect(pdfToImgMock.mock.calls[0]?.[1]).toMatchObject({ scale: 0.75 });
    });

    test("keeps normal page sizes at default full OCR raster scale", async () => {
        const bytes = await buildPDFBinary((pdf) => {
            pdf.addPage({ size: "letter" });
        });
        const loader = {
            getText: async () => "",
            getBinary: async () => bytes.slice().buffer,
        };
        rasterizedPages = [new Uint8Array([1])];
        fullOCRPageOutputs = ["# Letter"];

        await new PDFLoader({
            loader,
            mode: "ocr",
            model: {} as never,
        }).getText();

        expect(pdfToImgMock).toHaveBeenCalledTimes(1);
        expect(pdfToImgMock.mock.calls[0]?.[1]).toMatchObject({ scale: 1 });
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

    test("does not require storage in hybrid mode", async () => {
        const bytes = await buildPDFBinary((pdf) => {
            const page = pdf.addPage({ size: "letter" });
            page.drawText("Hybrid text", { x: 50, y: 740, size: 12 });
        });
        const loader = {
            getText: async () => "",
            getBinary: async () => bytes.slice().buffer,
        };

        await expect(new PDFLoader({ loader, mode: "hybrid", model: {} as never }).getText()).resolves.toContain(
            "Hybrid text"
        );
    });
});
