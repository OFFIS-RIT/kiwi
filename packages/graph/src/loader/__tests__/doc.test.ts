import { beforeEach, describe, expect, mock, test } from "bun:test";
import JSZip from "jszip";

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
    PDF_PREVIEW_SCALE: 1.5,
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

async function buildDOCXText(
    entries: Record<string, string | Uint8Array>,
    options: { ocr?: boolean } = {}
): Promise<string> {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(entries)) {
        zip.file(path, content);
    }

    const bytes = await zip.generateAsync({ type: "uint8array" });
    const loader = {
        getText: async () => Buffer.from(bytes).toString(),
        getBinary: async () => bytes.slice().buffer,
    };

    return new DOCXLoader({
        loader,
        ocr: options.ocr,
        model: {} as never,
        storage: { bucket: "bucket", imagePrefix: "graphs/graph-1/derived/file-1/images" },
    }).getText();
}

function buildDOCXEntries(options: {
    body: string;
    relationships?: string;
    styles?: string;
    numbering?: string;
    contentTypes?: string;
    extra?: Record<string, string | Uint8Array>;
}): Record<string, string | Uint8Array> {
    return {
        "[Content_Types].xml":
            options.contentTypes ??
            `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`,
        "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>${options.body}</w:body>
</w:document>`,
        "word/_rels/document.xml.rels":
            options.relationships ??
            `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
        ...(options.styles ? { "word/styles.xml": options.styles } : {}),
        ...(options.numbering ? { "word/numbering.xml": options.numbering } : {}),
        ...(options.extra ?? {}),
    };
}

describe("DOCXLoader", () => {
    beforeEach(() => {
        generateTextMock.mockClear();
        putNamedFileMock.mockClear();
    });

    test("returns plain text without image fences", async () => {
        const fixture = await buildFixture();

        expect(fixture.plain).toMatch(/^:::PAGE-1:::$/m);
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

    test("handles missing document parts as empty text", async () => {
        const text = await buildDOCXText({
            "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
        });

        expect(text).toBe("");
        expect(generateTextMock).not.toHaveBeenCalled();
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("plain mode does not parse OCR-only package parts", async () => {
        const text = await buildDOCXText({
            "[Content_Types].xml": "not valid xml",
            "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:hyperlink r:id="rMissing"><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>Plain link</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:r><w:t>Plain image text</w:t></w:r><w:r><w:drawing><a:blip r:embed="rImage"/></w:drawing></w:r></w:p>
  </w:body>
</w:document>`,
            "word/_rels/document.xml.rels": "not valid xml",
        });

        expect(text).toContain("Plain link");
        expect(text).toContain("Plain image text");
        expect(text).not.toContain("[Plain link]");
        expect(text).not.toContain(":::IMG-");
        expect(generateTextMock).not.toHaveBeenCalled();
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("renders styles, ordered lists, nested bullets, hyperlinks, and uneven tables", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                styles: `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="TitleStyle"><w:name w:val="Heading 2"/></w:style>
</w:styles>`,
                numbering: `<?xml version="1.0"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`,
                relationships: `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rLink" Target="https://example.test/docs" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"/>
</Relationships>`,
                body: `
<w:p><w:pPr><w:pStyle w:val="TitleStyle"/></w:pPr><w:r><w:t>Styled Heading</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>Ordered item</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>Nested bullet</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rLink"><w:r><w:rPr><w:b/><w:i/><w:strike/><w:u/></w:rPr><w:t>Example link</w:t></w:r></w:hyperlink></w:p>
<w:tbl>
  <w:tr><w:tc><w:p><w:r><w:t>Name|Pipe</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>Only one cell</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>`,
            }),
            { ocr: true }
        );

        expect(text).toMatch(/^## Styled Heading$/m);
        expect(text).toMatch(/^1\. Ordered item$/m);
        expect(text).toMatch(/^  - Nested bullet$/m);
        expect(text).toContain("[~~***Example link***~~](https://example.test/docs)");
        expect(text).toMatch(/\| Name\\\|Pipe \| Value \|/);
        expect(text).toMatch(/\| Only one cell \|  \|/);
    });

    test("extracts wrapper text and normalizes tabs breaks and Word hyphen elements", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                body: `
<w:p>
  <w:sdt><w:sdtContent><w:r><w:t>Alpha</w:t></w:r></w:sdtContent></w:sdt>
  <w:r><w:tab/></w:r>
  <w:customXml><w:r><w:t>Beta</w:t></w:r></w:customXml>
  <w:r><w:noBreakHyphen/></w:r>
  <w:ins><w:r><w:t>Gamma</w:t></w:r></w:ins>
  <w:r><w:br/></w:r>
  <w:fldSimple><w:r><w:t>Delta</w:t></w:r></w:fldSimple>
</w:p>`,
            })
        );

        expect(text).toContain("Alpha Beta-Gamma");
        expect(text).toContain("Delta");
    });

    test("normalizes repeated non-ASCII whitespace in DOCX text", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                body: `<w:p><w:r><w:t>Alpha\u00A0\u00A0Beta</w:t></w:r></w:p>`,
            })
        );

        expect(text).toBe(":::PAGE-1:::\n\nAlpha Beta");
    });

    test("emits page fences for explicit DOCX page breaks", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                body: `
    <w:p><w:r><w:t>Page one</w:t><w:br w:type="page"/><w:t>Page two</w:t><w:lastRenderedPageBreak/><w:t>Page three</w:t></w:r></w:p>
    <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Page four</w:t></w:r></w:p>`,
            })
        );

        expect(text).toBe(
            ":::PAGE-1:::\n\nPage one\n\n:::PAGE-2:::\n\nPage two\n\n:::PAGE-3:::\n\nPage three\n\n:::PAGE-4:::\n\nPage four"
        );
    });

    test("does not double count rendered page breaks after pageBreakBefore", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                body: `
    <w:p><w:r><w:t>Page one</w:t></w:r></w:p>
    <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:lastRenderedPageBreak/><w:t>Page two</w:t></w:r></w:p>
    <w:p><w:r><w:t>Still page two</w:t></w:r></w:p>`,
            })
        );

        expect(text).toBe(":::PAGE-1:::\n\nPage one\n\n:::PAGE-2:::\n\nPage two\n\nStill page two");
    });

    test("uses anchor hyperlinks when a DOCX hyperlink has no relationship target", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                body: `<w:p><w:hyperlink w:anchor="section-2"><w:r><w:t>Jump</w:t></w:r></w:hyperlink></w:p>`,
            }),
            { ocr: true }
        );

        expect(text).toBe(":::PAGE-1:::\n\n[Jump](#section-2)");
    });

    test("extracts multiple inline OCR images with stable ids and content types", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                contentTypes: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/media/diagram.bin" ContentType="image/png"/>
</Types>`,
                relationships: `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rImage1" Target="media/one.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>
  <Relationship Id="rImage2" Target="media/diagram.bin" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>
</Relationships>`,
                body: `
<w:p><w:r><w:t>Before</w:t></w:r><w:r><w:drawing><a:blip r:embed="rImage1"/></w:drawing></w:r></w:p>
<w:p><w:r><w:drawing><a:blip r:embed="rImage2"/></w:drawing></w:r><w:r><w:t>After</w:t></w:r></w:p>`,
                extra: {
                    "word/media/one.png": Uint8Array.of(1, 2, 3),
                    "word/media/diagram.bin": Uint8Array.of(4, 5, 6),
                },
            }),
            { ocr: true }
        );

        expect(text).toContain("Before");
        expect(text).toContain("After");
        expect(text).toContain('<image id="img-1" key="graphs/graph-1/derived/file-1/images/img-1.png">');
        expect(text).toContain('<image id="img-2" key="graphs/graph-1/derived/file-1/images/img-2.png">');
        expect(putNamedFileMock.mock.calls.map((call) => call[0])).toEqual(["img-1.png", "img-2.png"]);
        expect(generateTextMock).toHaveBeenCalledTimes(2);
    });

    test("reuses one OCR asset for repeated DOCX image targets", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                relationships: `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rImage" Target="media/logo.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>
</Relationships>`,
                body: `
<w:p><w:r><w:t>First logo</w:t></w:r><w:r><w:drawing><a:blip r:embed="rImage"/></w:drawing></w:r></w:p>
<w:p><w:r><w:t>Second logo</w:t></w:r><w:r><w:drawing><a:blip r:embed="rImage"/></w:drawing></w:r></w:p>`,
                extra: {
                    "word/media/logo.png": Uint8Array.of(1, 2, 3),
                },
            }),
            { ocr: true }
        );

        expect(text).toContain("First logo");
        expect(text).toContain("Second logo");
        expect(text.match(/<image id="img-1"/g) ?? []).toHaveLength(2);
        expect(putNamedFileMock).toHaveBeenCalledTimes(1);
        expect(generateTextMock).toHaveBeenCalledTimes(1);
    });

    test("handles large synthetic DOCX documents", async () => {
        const paragraphCount = 1500;
        const body = Array.from(
            { length: paragraphCount },
            (_, index) => `<w:p><w:r><w:t>Large paragraph ${index + 1}</w:t></w:r></w:p>`
        ).join("");

        const text = await buildDOCXText(buildDOCXEntries({ body }));

        expect(text).toContain("Large paragraph 1");
        expect(text).toContain(`Large paragraph ${paragraphCount}`);
        expect(text.split("\n\n")).toHaveLength(paragraphCount + 1);
    });

    test("ignores images inside DOCX tables instead of creating orphan OCR assets", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                relationships: `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rImage" Target="media/inside.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>
</Relationships>`,
                body: `<w:tbl>
  <w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Preview</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>Diagram</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:drawing><a:blip r:embed="rImage"/></w:drawing></w:r></w:p></w:tc></w:tr>
</w:tbl>`,
                extra: {
                    "word/media/inside.png": Uint8Array.of(1, 2, 3),
                },
            }),
            { ocr: true }
        );

        expect(text).toMatch(/\| Name \| Preview \|/);
        expect(text).toMatch(/\| Diagram \|  \|/);
        expect(text).not.toContain(":::IMG-");
        expect(text).not.toContain("<image ");
        expect(generateTextMock).not.toHaveBeenCalled();
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("ignores unsafe image relationships without leaving OCR fences", async () => {
        const text = await buildDOCXText(
            buildDOCXEntries({
                relationships: `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rUnsafe" Target="../../evil.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>
</Relationships>`,
                body: `
<w:p><w:r><w:t>Safe text</w:t></w:r></w:p>
<w:p><w:r><w:drawing><a:blip r:embed="rUnsafe"/></w:drawing></w:r></w:p>`,
                extra: {
                    "evil.png": Uint8Array.of(1, 2, 3),
                },
            }),
            { ocr: true }
        );

        expect(text).toContain("Safe text");
        expect(text).not.toContain(":::IMG-");
        expect(text).not.toContain("<image ");
        expect(generateTextMock).not.toHaveBeenCalled();
        expect(putNamedFileMock).not.toHaveBeenCalled();
    });

    test("propagates invalid DOCX zip errors", async () => {
        const loader = {
            getText: async () => "not a zip",
            getBinary: async () => Uint8Array.from([1, 2, 3]).buffer,
        };

        await expect(new DOCXLoader({ loader }).getText()).rejects.toThrow();
    });
});
