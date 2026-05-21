import {
    createImageIdFactory,
    getMimeTypeForPath,
    getRelationshipsForPart,
    loadOOXMLZip,
    parseContentTypes,
    readZipBinary,
    readZipText,
} from "../ooxml/package";
import {
    childElements,
    findDescendants,
    findFirstChild,
    findFirstDescendant,
    getAttribute,
    getDocumentRoot,
    getLocalName,
    parseXml,
} from "../ooxml/xml";
import type { XMLNodeLike } from "../ooxml/types";
import { clampHeadingLevel, cleanInlineText, detectHeadingLevel, formatInlineText } from "./text";
import type { DOCBlock, DOCNumbering, DOCParseContext, DOCStyles, ParagraphListInfo, ParsedDOC } from "./types";

const PLAIN_INLINE_FORMAT = { bold: false, italic: false, strike: false, underline: false };

type InlineSink = {
    onText: (text: string) => void;
    onImage: (id: string) => void;
    onPageBreak: () => void;
};

export function parseDOCX(content: ArrayBuffer, ocr: boolean): Promise<ParsedDOC> {
    return parseDOCXDocument(content, ocr);
}

async function parseDOCXDocument(content: ArrayBuffer, ocr: boolean): Promise<ParsedDOC> {
    const zip = await loadOOXMLZip(content);
    const documentXml = await readZipText(zip, "word/document.xml");
    if (!documentXml) {
        return { blocks: [], images: [] };
    }

    const relationships = ocr ? await getRelationshipsForPart(zip, "word/document.xml") : new Map();
    const contentTypes = ocr
        ? parseContentTypes(await readZipText(zip, "[Content_Types].xml"))
        : { defaults: new Map(), overrides: new Map() };
    const styles: DOCStyles = hasWordElement(documentXml, "pStyle")
        ? parseDOCStyles(await readZipText(zip, "word/styles.xml"))
        : new Map();
    const numbering = hasWordElement(documentXml, "numPr")
        ? parseDOCNumbering(await readZipText(zip, "word/numbering.xml"))
        : createEmptyNumbering();
    const context: DOCParseContext = {
        zip,
        relationships,
        contentTypes,
        styles,
        numbering,
        images: [],
        imageIdByTarget: new Map(),
        nextImageId: createImageIdFactory(),
        ocr,
    };

    const document = parseXml(documentXml);
    const root = getDocumentRoot(document);
    const body = root ? (findFirstChild(root, "body") ?? findFirstDescendant(root, "body")) : null;
    if (!body) {
        return { blocks: [], images: [] };
    }

    const blocks: DOCBlock[] = [];
    for (const node of childElements(body)) {
        switch (getLocalName(node)) {
            case "p":
                blocks.push(...(await parseParagraph(node, context)));
                break;
            case "tbl": {
                const table = await parseTable(node, context);
                if (table) {
                    blocks.push(table);
                }
                break;
            }
            default:
                break;
        }
    }

    return {
        blocks,
        images: context.images,
    };
}

async function parseParagraph(paragraph: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock[]> {
    const properties = findFirstChild(paragraph, "pPr");
    const headingLevel = getParagraphHeadingLevel(properties, context.styles);
    const listInfo = getParagraphListInfo(properties, context.numbering);
    const blocks: DOCBlock[] = [];
    let textParts: string[] = [];

    if (hasPageBreakBefore(properties)) {
        blocks.push({ kind: "pageBreak" });
    }

    const flushText = () => {
        const text = cleanInlineText(textParts.join(""));
        textParts = [];
        if (!text) {
            return;
        }

        if (headingLevel !== null) {
            blocks.push({ kind: "heading", level: headingLevel, text });
            return;
        }

        if (listInfo) {
            blocks.push({ kind: "bullet", text, level: listInfo.level, ordered: listInfo.ordered });
            return;
        }

        blocks.push({ kind: "paragraph", text });
    };

    await collectParagraphContent(paragraph, context, {
        onText: (text) => textParts.push(text),
        onImage: (id) => {
            flushText();
            blocks.push({ kind: "image", id });
        },
        onPageBreak: () => {
            flushText();
            blocks.push({ kind: "pageBreak" });
        },
    });

    flushText();
    return blocks;
}

async function parseTable(table: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock | null> {
    const renderedRows: string[][] = [];

    for (const row of childElements(table)) {
        if (getLocalName(row) !== "tr") {
            continue;
        }

        const renderedCells: string[] = [];
        for (const cell of childElements(row)) {
            if (getLocalName(cell) !== "tc") {
                continue;
            }

            renderedCells.push(await extractTableCellText(cell, context));
        }

        if (renderedCells.length > 0) {
            renderedRows.push(renderedCells);
        }
    }

    return renderedRows.length === 0 ? null : { kind: "table", rows: renderedRows };
}

async function extractTableCellText(cell: XMLNodeLike, context: DOCParseContext): Promise<string> {
    const parts: string[] = [];
    const textOnlyContext = { ...context, ocr: false };

    for (const node of childElements(cell)) {
        if (getLocalName(node) !== "p") {
            continue;
        }

        const textParts: string[] = [];
        await collectParagraphContent(node, textOnlyContext, {
            onText: (text) => textParts.push(text),
            onImage: () => undefined,
            onPageBreak: () => undefined,
        });

        const text = cleanInlineText(textParts.join(""));

        if (text) {
            parts.push(text.replace(/\s*\n\s*/g, " "));
        }
    }

    return cleanInlineText(parts.join(" "));
}

async function collectParagraphContent(
    paragraph: XMLNodeLike,
    context: DOCParseContext,
    sink: InlineSink
): Promise<void> {
    for (const child of childElements(paragraph)) {
        if (getLocalName(child) === "pPr") {
            continue;
        }

        await parseInlineNode(child, context, null, sink);
    }
}

async function parseInlineNode(
    node: XMLNodeLike,
    context: DOCParseContext,
    hyperlinkTarget: string | null,
    sink: InlineSink
): Promise<void> {
    switch (getLocalName(node)) {
        case "r":
            await parseRun(node, context, hyperlinkTarget, sink);
            return;
        case "hyperlink": {
            let target: string | null = null;
            if (context.ocr) {
                const relationshipId = getAttribute(node, "r:id", "id");
                const anchor = getAttribute(node, "w:anchor", "anchor");
                const relationship = relationshipId ? context.relationships.get(relationshipId) : null;
                target = relationship?.target ?? (anchor ? `#${anchor}` : null);
            }

            for (const child of childElements(node)) {
                await parseInlineNode(child, context, target, sink);
            }

            return;
        }
        case "smartTag":
        case "sdt":
        case "sdtContent":
        case "ins":
        case "customXml":
        case "fldSimple": {
            for (const child of childElements(node)) {
                await parseInlineNode(child, context, hyperlinkTarget, sink);
            }

            return;
        }
        default:
            return;
    }
}

async function parseRun(
    run: XMLNodeLike,
    context: DOCParseContext,
    hyperlinkTarget: string | null,
    sink: InlineSink
): Promise<void> {
    const format = context.ocr ? getRunFormat(run) : PLAIN_INLINE_FORMAT;

    for (const child of childElements(run)) {
        switch (getLocalName(child)) {
            case "rPr":
                break;
            case "t": {
                const value = child.textContent ?? "";
                if (value) {
                    sink.onText(formatInlineText(value, format, context.ocr ? hyperlinkTarget : null, context.ocr));
                }
                break;
            }
            case "br":
                if (getAttribute(child, "w:type", "type") === "page") {
                    sink.onPageBreak();
                    break;
                }

                sink.onText("\n");
                break;
            case "lastRenderedPageBreak":
                sink.onPageBreak();
                break;
            case "cr":
                sink.onText("\n");
                break;
            case "tab":
                sink.onText("\t");
                break;
            case "noBreakHyphen":
            case "softHyphen":
                sink.onText("-");
                break;
            case "drawing":
            case "pict": {
                if (!context.ocr) {
                    break;
                }

                const imageId = await extractImageId(child, context);
                if (imageId) {
                    sink.onImage(imageId);
                }
                break;
            }
            default:
                break;
        }
    }
}

function hasPageBreakBefore(properties: XMLNodeLike | null): boolean {
    return properties ? findFirstChild(properties, "pageBreakBefore") !== null : false;
}

function getRunFormat(run: XMLNodeLike): typeof PLAIN_INLINE_FORMAT {
    const props = findFirstChild(run, "rPr");
    return {
        bold: hasRunFormatting(props, "b"),
        italic: hasRunFormatting(props, "i"),
        strike: hasRunFormatting(props, "strike"),
        underline: hasRunFormatting(props, "u"),
    };
}

function hasWordElement(xml: string, name: string): boolean {
    return xml.includes(`:${name}`) || xml.includes(`<${name}`);
}

async function extractImageId(node: XMLNodeLike, context: DOCParseContext): Promise<string | null> {
    const blip = findFirstDescendant(node, "blip");
    const imageData = blip ? null : findFirstDescendant(node, "imagedata");
    const relationshipId = blip
        ? getAttribute(blip, "r:embed", "embed", "r:link", "link")
        : imageData
          ? getAttribute(imageData, "r:id", "id")
          : null;
    if (!relationshipId) {
        return null;
    }

    const relationship = context.relationships.get(relationshipId);
    if (!relationship || relationship.external) {
        return null;
    }

    const cachedId = context.imageIdByTarget.get(relationship.target);
    if (cachedId) {
        return cachedId;
    }

    const content = await readZipBinary(context.zip, relationship.target);
    if (!content) {
        return null;
    }

    const id = context.nextImageId();
    context.images.push({
        id,
        type: getMimeTypeForPath(context.contentTypes, relationship.target),
        content,
    });
    context.imageIdByTarget.set(relationship.target, id);

    return id;
}

function getParagraphHeadingLevel(properties: XMLNodeLike | null, styles: DOCStyles): number | null {
    if (!properties) {
        return null;
    }

    const outlineLevel = findFirstChild(properties, "outlineLvl");
    const outlineValue = outlineLevel ? getAttribute(outlineLevel, "w:val", "val") : null;
    if (outlineValue !== null) {
        const level = Number(outlineValue);
        if (Number.isFinite(level)) {
            return clampHeadingLevel(level + 1);
        }
    }

    const style = findFirstChild(properties, "pStyle");
    const styleId = style ? getAttribute(style, "w:val", "val") : null;
    if (!styleId) {
        return null;
    }

    const fromStyle = styles.get(styleId)?.headingLevel;
    return fromStyle ?? detectHeadingLevel(styleId);
}

function getParagraphListInfo(properties: XMLNodeLike | null, numbering: DOCNumbering): ParagraphListInfo | null {
    const numPr = properties ? findFirstChild(properties, "numPr") : null;
    if (!numPr) {
        return null;
    }

    const numId = findFirstChild(numPr, "numId");
    const ilvl = findFirstChild(numPr, "ilvl");
    const numIdValue = numId ? getAttribute(numId, "w:val", "val") : null;
    if (!numIdValue) {
        return null;
    }

    const levelValue = ilvl ? getAttribute(ilvl, "w:val", "val") : null;
    const level = Number.isFinite(Number(levelValue)) ? Number(levelValue) : 0;
    const format = getNumberingFormat(numbering, numIdValue, level);

    return {
        level: Math.max(0, level),
        ordered: isOrderedNumberingFormat(format),
    };
}

function getNumberingFormat(numbering: DOCNumbering, numId: string, level: number): string | null {
    const abstractId = numbering.numToAbstract.get(numId);
    if (!abstractId) {
        return null;
    }

    const levels = numbering.abstractFormats.get(abstractId);
    return levels?.get(level) ?? levels?.get(0) ?? null;
}

function isOrderedNumberingFormat(format: string | null): boolean {
    if (!format) {
        return false;
    }

    return format !== "bullet" && format !== "none";
}

function hasRunFormatting(properties: XMLNodeLike | null, name: string): boolean {
    if (!properties) {
        return false;
    }

    const node = findFirstChild(properties, name);
    if (!node) {
        return false;
    }

    const value = getAttribute(node, "w:val", "val");
    if (value === null) {
        return true;
    }

    return value !== "0" && value !== "false";
}

function createEmptyNumbering(): DOCNumbering {
    return {
        numToAbstract: new Map(),
        abstractFormats: new Map(),
    };
}

function parseDOCStyles(xml: string | null): DOCStyles {
    const styles: DOCStyles = new Map();
    if (!xml) {
        return styles;
    }

    const document = getDocumentRootFromXml(xml);
    if (!document) {
        return styles;
    }

    for (const style of findDescendants(document, "style")) {
        const styleId = getAttribute(style, "w:styleId", "styleId");
        if (!styleId) {
            continue;
        }

        const nameNode = findFirstChild(style, "name");
        const name = nameNode ? getAttribute(nameNode, "w:val", "val") : null;
        const headingLevel = detectHeadingLevel(name ?? styleId);
        styles.set(styleId, { name, headingLevel });
    }

    return styles;
}

function parseDOCNumbering(xml: string | null): DOCNumbering {
    const numbering = createEmptyNumbering();
    if (!xml) {
        return numbering;
    }

    const root = getDocumentRootFromXml(xml);
    if (!root) {
        return numbering;
    }

    for (const abstractNum of findDescendants(root, "abstractNum")) {
        const abstractId = getAttribute(abstractNum, "w:abstractNumId", "abstractNumId");
        if (!abstractId) {
            continue;
        }

        const levels = new Map<number, string>();
        for (const level of childElements(abstractNum)) {
            if (getLocalName(level) !== "lvl") {
                continue;
            }

            const ilvlValue = getAttribute(level, "w:ilvl", "ilvl");
            const ilvl = Number.isFinite(Number(ilvlValue)) ? Number(ilvlValue) : 0;
            const numFmt = findFirstChild(level, "numFmt");
            const format = numFmt ? getAttribute(numFmt, "w:val", "val") : null;
            if (format) {
                levels.set(ilvl, format);
            }
        }

        numbering.abstractFormats.set(abstractId, levels);
    }

    for (const num of findDescendants(root, "num")) {
        const numId = getAttribute(num, "w:numId", "numId");
        const abstractNumId = findFirstChild(num, "abstractNumId");
        const abstractId = abstractNumId ? getAttribute(abstractNumId, "w:val", "val") : null;
        if (numId && abstractId) {
            numbering.numToAbstract.set(numId, abstractId);
        }
    }

    return numbering;
}

function getDocumentRootFromXml(xml: string): XMLNodeLike | null {
    return getDocumentRoot(parseXml(xml));
}
