import { DOMParser } from "@xmldom/xmldom";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import JSZip from "jszip";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { processOCRImages } from "../lib/ocr-image";

type DOCOCRImage = {
    id: string;
    type: string;
    content: Uint8Array;
};

type ParsedDOC = {
    blocks: DOCBlock[];
    images: DOCOCRImage[];
};

type DOCBlock =
    | { kind: "heading"; level: number; text: string }
    | { kind: "paragraph"; text: string }
    | { kind: "bullet"; text: string; level: number; ordered: boolean }
    | { kind: "table"; rows: string[][] }
    | { kind: "image"; id: string };

type InlinePiece = { kind: "text"; text: string } | { kind: "image"; id: string };

type XMLNodeLike = {
    nodeType?: number;
    nodeName?: string | null;
    localName?: string | null;
    textContent?: string | null;
    childNodes?: ArrayLike<unknown>;
    getAttribute?: (name: string) => string | null;
};

type XMLDocumentLike = {
    documentElement?: unknown;
};

type ContentTypes = {
    defaults: Map<string, string>;
    overrides: Map<string, string>;
};

type DOCStyles = Map<string, { name: string | null; headingLevel: number | null }>;

type DOCNumbering = {
    numToAbstract: Map<string, string>;
    abstractFormats: Map<string, Map<number, string>>;
};

type ParagraphListInfo = {
    level: number;
    ordered: boolean;
};

type DOCParseContext = {
    zip: JSZip;
    relationships: Map<string, string>;
    contentTypes: ContentTypes;
    styles: DOCStyles;
    numbering: DOCNumbering;
    images: DOCOCRImage[];
    nextImageId: () => string;
    ocr: boolean;
};

const IMAGE_FENCE_PATTERN = /^:::IMG-[^:]+:::$/;
const XML_MIME_TYPE = "application/xml";
const XML_ERROR_HANDLER = {
    warning: () => undefined,
    error: () => undefined,
    fatalError: () => undefined,
};

export class DOCXLoader implements GraphLoader {
    readonly filetype = "docx";
    private cachedOCRText?: Promise<string>;

    constructor(
        private options: {
            loader: GraphBinaryLoader;
            ocr?: boolean;
            model?: LanguageModelV3;
            storage?: { bucket: string; imagePrefix: string };
        }
    ) {}

    async getText(): Promise<string> {
        if (this.options.ocr) {
            this.cachedOCRText ??= this.getOCRText();
            return this.cachedOCRText;
        }

        const content = await this.options.loader.getBinary();
        const parsed = await parseDOCX(content, false);
        return renderMarkdown(parsed.blocks);
    }

    private async getOCRText(): Promise<string> {
        const model = this.options.model;
        const storage = this.options.storage;
        if (!model || !storage) {
            throw new Error("DOCX OCR requires an image model and storage configuration");
        }

        const content = await this.options.loader.getBinary();
        const parsed = await parseDOCX(content, true);
        const markdown = renderMarkdown(parsed.blocks);
        return processOCRImages(markdown, parsed.images, model, storage);
    }
}

async function parseDOCX(content: ArrayBuffer, ocr: boolean): Promise<ParsedDOC> {
    const zip = await JSZip.loadAsync(content);
    const documentXml = await readZipText(zip, "word/document.xml");
    if (!documentXml) {
        return { blocks: [], images: [] };
    }

    const context: DOCParseContext = {
        zip,
        relationships: await getRelationshipsForPart(zip, "word/document.xml"),
        contentTypes: parseContentTypes(await readZipText(zip, "[Content_Types].xml")),
        styles: parseDOCStyles(await readZipText(zip, "word/styles.xml")),
        numbering: parseDOCNumbering(await readZipText(zip, "word/numbering.xml")),
        images: [],
        nextImageId: createImageIdFactory(),
        ocr,
    };

    const document = parseXml(documentXml);
    const root = getDocumentRoot(document);
    const body = root ? findFirstDescendant(root, "body") : null;
    if (!body) {
        return { blocks: [], images: [] };
    }

    const blocks: DOCBlock[] = [];
    for (const node of getChildElements(body)) {
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

function createImageIdFactory(): () => string {
    let imageCounter = 0;
    return () => {
        imageCounter += 1;
        return `img-${imageCounter}`;
    };
}

async function parseParagraph(paragraph: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock[]> {
    const headingLevel = getParagraphHeadingLevel(paragraph, context.styles);
    const listInfo = getParagraphListInfo(paragraph, context.numbering);
    const pieces = await collectParagraphPieces(paragraph, context);
    if (pieces.length === 0) {
        return [];
    }

    const blocks: DOCBlock[] = [];
    let textBuffer = "";

    const flushText = () => {
        const text = normalizeInlineText(textBuffer);
        textBuffer = "";
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

    for (const piece of pieces) {
        if (piece.kind === "text") {
            textBuffer += piece.text;
            continue;
        }

        flushText();
        blocks.push({ kind: "image", id: piece.id });
    }

    flushText();
    return blocks;
}

async function parseTable(table: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock | null> {
    const rows = getChildElements(table)
        .filter((node) => getLocalName(node) === "tr")
        .map((row) => row)
        .filter(Boolean);

    const renderedRows: string[][] = [];
    for (const row of rows) {
        const cells = getChildElements(row)
            .filter((node) => getLocalName(node) === "tc")
            .map((cell) => cell);
        if (cells.length === 0) {
            continue;
        }

        const renderedCells = await Promise.all(cells.map((cell) => extractTableCellText(cell, context)));
        renderedRows.push(renderedCells);
    }

    const nonEmptyRows = renderedRows.filter((row) => row.some((cell) => cell.length > 0) || row.length > 0);
    if (nonEmptyRows.length === 0) {
        return null;
    }

    return { kind: "table", rows: nonEmptyRows };
}

async function extractTableCellText(cell: XMLNodeLike, context: DOCParseContext): Promise<string> {
    const parts: string[] = [];

    for (const node of getChildElements(cell)) {
        if (getLocalName(node) !== "p") {
            continue;
        }

        const pieces = await collectParagraphPieces(node, context);
        const text = normalizeInlineText(
            pieces
                .filter((piece): piece is Extract<InlinePiece, { kind: "text" }> => piece.kind === "text")
                .map((piece) => piece.text)
                .join("")
        );

        if (text) {
            parts.push(text.replace(/\s*\n\s*/g, " "));
        }
    }

    return normalizeInlineText(parts.join(" "));
}

async function collectParagraphPieces(paragraph: XMLNodeLike, context: DOCParseContext): Promise<InlinePiece[]> {
    const pieces: InlinePiece[] = [];

    for (const child of getChildElements(paragraph)) {
        if (getLocalName(child) === "pPr") {
            continue;
        }

        pieces.push(...(await parseInlineNode(child, context, null)));
    }

    return mergeInlineTextPieces(pieces);
}

async function parseInlineNode(
    node: XMLNodeLike,
    context: DOCParseContext,
    hyperlinkTarget: string | null
): Promise<InlinePiece[]> {
    switch (getLocalName(node)) {
        case "r":
            return parseRun(node, context, hyperlinkTarget);
        case "hyperlink": {
            const relationshipId = getAttribute(node, "r:id", "id");
            const anchor = getAttribute(node, "w:anchor", "anchor");
            const target = relationshipId
                ? (context.relationships.get(relationshipId) ?? null)
                : anchor
                  ? `#${anchor}`
                  : null;
            const pieces: InlinePiece[] = [];

            for (const child of getChildElements(node)) {
                pieces.push(...(await parseInlineNode(child, context, target)));
            }

            return mergeInlineTextPieces(pieces);
        }
        case "smartTag":
        case "sdt":
        case "sdtContent":
        case "ins":
        case "customXml":
        case "fldSimple": {
            const pieces: InlinePiece[] = [];
            for (const child of getChildElements(node)) {
                pieces.push(...(await parseInlineNode(child, context, hyperlinkTarget)));
            }

            return mergeInlineTextPieces(pieces);
        }
        default:
            return [];
    }
}

async function parseRun(
    run: XMLNodeLike,
    context: DOCParseContext,
    hyperlinkTarget: string | null
): Promise<InlinePiece[]> {
    const props = findFirstChild(run, "rPr");
    const format = {
        bold: hasRunFormatting(props, "b"),
        italic: hasRunFormatting(props, "i"),
        strike: hasRunFormatting(props, "strike"),
        underline: hasRunFormatting(props, "u"),
    };

    const pieces: InlinePiece[] = [];
    for (const child of getChildElements(run)) {
        switch (getLocalName(child)) {
            case "rPr":
                break;
            case "t": {
                const value = child.textContent ?? "";
                if (value) {
                    pieces.push({ kind: "text", text: formatInlineText(value, format, hyperlinkTarget, context.ocr) });
                }
                break;
            }
            case "br":
            case "cr":
                pieces.push({ kind: "text", text: "\n" });
                break;
            case "tab":
                pieces.push({ kind: "text", text: "\t" });
                break;
            case "noBreakHyphen":
            case "softHyphen":
                pieces.push({ kind: "text", text: "-" });
                break;
            case "drawing":
            case "pict": {
                if (!context.ocr) {
                    break;
                }

                const imageId = await extractImageId(child, context);
                if (imageId) {
                    pieces.push({ kind: "image", id: imageId });
                }
                break;
            }
            default:
                break;
        }
    }

    return mergeInlineTextPieces(pieces);
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

    const targetPath = context.relationships.get(relationshipId);
    if (!targetPath || /^https?:\/\//i.test(targetPath)) {
        return null;
    }

    const file = context.zip.file(targetPath);
    if (!file) {
        return null;
    }

    const id = context.nextImageId();
    const content = await file.async("uint8array");
    context.images.push({
        id,
        type: getMimeTypeForPath(context.contentTypes, targetPath),
        content,
    });

    return id;
}

function getParagraphHeadingLevel(paragraph: XMLNodeLike, styles: DOCStyles): number | null {
    const properties = findFirstChild(paragraph, "pPr");
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

function getParagraphListInfo(paragraph: XMLNodeLike, numbering: DOCNumbering): ParagraphListInfo | null {
    const properties = findFirstChild(paragraph, "pPr");
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

function formatInlineText(
    value: string,
    format: { bold: boolean; italic: boolean; strike: boolean; underline: boolean },
    hyperlinkTarget: string | null,
    markdown: boolean
): string {
    if (!markdown) {
        return value;
    }

    const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
    const trailingWhitespace = value.match(/\s*$/)?.[0] ?? "";
    let text = value.trim();
    if (!text) {
        return value;
    }

    if (format.bold && format.italic) {
        text = `***${text}***`;
    } else if (format.bold) {
        text = `**${text}**`;
    } else if (format.italic || format.underline) {
        text = `*${text}*`;
    }

    if (format.strike) {
        text = `~~${text}~~`;
    }

    if (hyperlinkTarget) {
        text = `[${text}](${hyperlinkTarget})`;
    }

    return `${leadingWhitespace}${text}${trailingWhitespace}`;
}

function mergeInlineTextPieces(pieces: InlinePiece[]): InlinePiece[] {
    return pieces.reduce<InlinePiece[]>((acc, piece) => {
        const previous = acc.at(-1);
        if (piece.kind === "text" && previous?.kind === "text") {
            previous.text += piece.text;
            return acc;
        }

        acc.push(piece);
        return acc;
    }, []);
}

function normalizeInlineText(value: string): string {
    const lines = value
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
        .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));

    return lines.join("\n");
}

function renderMarkdown(blocks: DOCBlock[]): string {
    const rendered = blocks
        .map((block) => {
            switch (block.kind) {
                case "heading":
                    return `${"#".repeat(clampHeadingLevel(block.level))} ${block.text}`;
                case "paragraph":
                    return block.text;
                case "bullet": {
                    const indent = "  ".repeat(Math.max(0, block.level));
                    const marker = block.ordered ? "1." : "-";
                    return `${indent}${marker} ${block.text}`;
                }
                case "table":
                    return rowsToMarkdown(block.rows);
                case "image":
                    return `:::IMG-${block.id}:::`;
            }
        })
        .filter(Boolean);

    return normalizeMarkdownText(rendered.join("\n\n"));
}

function rowsToMarkdown(rows: string[][]): string {
    if (rows.length === 0) {
        return "";
    }

    const columnCount = Math.max(...rows.map((row) => row.length));
    if (!Number.isFinite(columnCount) || columnCount <= 0) {
        return "";
    }

    const normalizedRows = rows.map((row) => {
        const nextRow = row.map((cell) => escapeMarkdownTableCell(normalizeInlineText(cell).replace(/\s*\n\s*/g, " ")));
        while (nextRow.length < columnCount) {
            nextRow.push("");
        }

        return nextRow;
    });

    const header = normalizedRows[0] ?? [];
    const separator = Array.from({ length: columnCount }, () => "---");
    const body = normalizedRows.slice(1);

    return [
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
}

function normalizeMarkdownText(text: string): string {
    const lines = text
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => normalizeMarkdownLine(line))
        .reduce<string[]>((acc, line) => {
            if (!line) {
                if (acc.at(-1) !== "") {
                    acc.push("");
                }

                return acc;
            }

            acc.push(line);
            return acc;
        }, []);

    while (lines.at(0) === "") {
        lines.shift();
    }

    while (lines.at(-1) === "") {
        lines.pop();
    }

    return lines.join("\n");
}

function normalizeMarkdownLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) {
        return "";
    }

    if (IMAGE_FENCE_PATTERN.test(trimmed)) {
        return trimmed;
    }

    if (/^#+\s/.test(trimmed)) {
        const hashes = trimmed.match(/^#+/)?.[0] ?? "#";
        return `${hashes} ${normalizeWhitespace(trimmed.slice(hashes.length))}`;
    }

    const bulletMatch = line.match(/^(\s*)(- |\d+\. )(.*)$/);
    if (bulletMatch) {
        const indent = bulletMatch[1] ?? "";
        const marker = bulletMatch[2] ?? "-";
        const value = bulletMatch[3] ?? "";
        return `${indent}${marker.trim()} ${normalizeWhitespace(value)}`;
    }

    if (/^\|.*\|$/.test(trimmed)) {
        return trimmed;
    }

    return normalizeWhitespace(trimmed);
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}

function clampHeadingLevel(level: number): number {
    return Math.min(6, Math.max(1, level));
}

function detectHeadingLevel(value: string): number | null {
    const match = value.match(/heading\s*([1-6])/i);
    return match ? clampHeadingLevel(Number(match[1])) : null;
}

function parseDOCStyles(xml: string | null): DOCStyles {
    const styles: DOCStyles = new Map();
    if (!xml) {
        return styles;
    }

    const document = parseXml(xml);
    const root = getDocumentRoot(document);
    if (!root) {
        return styles;
    }

    for (const style of findDescendants(root, "style")) {
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
    const numbering: DOCNumbering = {
        numToAbstract: new Map(),
        abstractFormats: new Map(),
    };
    if (!xml) {
        return numbering;
    }

    const document = parseXml(xml);
    const root = getDocumentRoot(document);
    if (!root) {
        return numbering;
    }

    for (const abstractNum of findDescendants(root, "abstractNum")) {
        const abstractId = getAttribute(abstractNum, "w:abstractNumId", "abstractNumId");
        if (!abstractId) {
            continue;
        }

        const levels = new Map<number, string>();
        for (const level of getChildElements(abstractNum).filter((node) => getLocalName(node) === "lvl")) {
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

function parseContentTypes(xml: string | null): ContentTypes {
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    if (!xml) {
        return { defaults, overrides };
    }

    const document = parseXml(xml);
    const root = getDocumentRoot(document);
    if (!root) {
        return { defaults, overrides };
    }

    for (const node of findDescendants(root, "Default")) {
        const extension = getAttribute(node, "Extension");
        const contentType = getAttribute(node, "ContentType");
        if (extension && contentType) {
            defaults.set(extension.toLowerCase(), contentType);
        }
    }

    for (const node of findDescendants(root, "Override")) {
        const partName = getAttribute(node, "PartName");
        const contentType = getAttribute(node, "ContentType");
        if (partName && contentType) {
            overrides.set(normalizeZipPath(partName), contentType);
        }
    }

    return { defaults, overrides };
}

function getMimeTypeForPath(contentTypes: ContentTypes, path: string): string {
    const normalizedPath = normalizeZipPath(path);
    const override = contentTypes.overrides.get(normalizedPath);
    if (override) {
        return override;
    }

    const extension = normalizedPath.split(".").at(-1)?.toLowerCase();
    if (extension) {
        const fromDefaults = contentTypes.defaults.get(extension);
        if (fromDefaults) {
            return fromDefaults;
        }
    }

    switch (extension) {
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "gif":
            return "image/gif";
        case "bmp":
            return "image/bmp";
        case "svg":
            return "image/svg+xml";
        case "tif":
        case "tiff":
            return "image/tiff";
        case "webp":
            return "image/webp";
        default:
            return "application/octet-stream";
    }
}

function parseXml(xml: string): XMLDocumentLike {
    return new DOMParser({ errorHandler: XML_ERROR_HANDLER }).parseFromString(
        xml,
        XML_MIME_TYPE
    ) as unknown as XMLDocumentLike;
}

function getDocumentRoot(document: XMLDocumentLike): XMLNodeLike | null {
    return isElementNode(document.documentElement) ? document.documentElement : null;
}

function findFirstChild(node: XMLNodeLike, name: string): XMLNodeLike | null {
    return getChildElements(node).find((child) => getLocalName(child) === name) ?? null;
}

function findFirstDescendant(node: XMLNodeLike, name: string): XMLNodeLike | null {
    for (const child of getChildElements(node)) {
        if (getLocalName(child) === name) {
            return child;
        }

        const nested = findFirstDescendant(child, name);
        if (nested) {
            return nested;
        }
    }

    return null;
}

function findDescendants(node: XMLNodeLike, name: string): XMLNodeLike[] {
    const matches: XMLNodeLike[] = [];
    for (const child of getChildElements(node)) {
        if (getLocalName(child) === name) {
            matches.push(child);
        }

        matches.push(...findDescendants(child, name));
    }

    return matches;
}

function getChildElements(node: XMLNodeLike): XMLNodeLike[] {
    const childNodes = node.childNodes;
    if (!childNodes) {
        return [];
    }

    const children: XMLNodeLike[] = [];
    for (let index = 0; index < childNodes.length; index += 1) {
        const child = childNodes[index];
        if (isElementNode(child)) {
            children.push(child);
        }
    }

    return children;
}

function isElementNode(value: unknown): value is XMLNodeLike {
    return typeof value === "object" && value !== null && (value as XMLNodeLike).nodeType === 1;
}

function getLocalName(node: XMLNodeLike): string {
    const localName = node.localName;
    if (typeof localName === "string" && localName.length > 0) {
        return localName;
    }

    const nodeName = node.nodeName ?? "";
    const colonIndex = nodeName.indexOf(":");
    return colonIndex >= 0 ? nodeName.slice(colonIndex + 1) : nodeName;
}

function getAttribute(node: XMLNodeLike, ...names: string[]): string | null {
    if (typeof node.getAttribute !== "function") {
        return null;
    }

    for (const name of names) {
        const value = node.getAttribute(name);
        if (value !== null && value !== "") {
            return value;
        }
    }

    return null;
}

async function readZipText(zip: JSZip, path: string): Promise<string | null> {
    const file = zip.file(path);
    return file ? file.async("text") : null;
}

async function getRelationshipsForPart(zip: JSZip, partPath: string): Promise<Map<string, string>> {
    const relationships = new Map<string, string>();
    const relsPath = getRelationshipsPath(partPath);
    const relsXml = await readZipText(zip, relsPath);
    if (!relsXml) {
        return relationships;
    }

    const document = parseXml(relsXml);
    const root = getDocumentRoot(document);
    if (!root) {
        return relationships;
    }

    for (const relationship of findDescendants(root, "Relationship")) {
        const id = getAttribute(relationship, "Id");
        const target = getAttribute(relationship, "Target");
        const targetMode = getAttribute(relationship, "TargetMode");
        if (!id || !target) {
            continue;
        }

        relationships.set(id, targetMode === "External" ? target : resolveZipPath(getDirectoryPath(partPath), target));
    }

    return relationships;
}

function getRelationshipsPath(partPath: string): string {
    const directory = getDirectoryPath(partPath);
    const filename = partPath.split("/").at(-1) ?? partPath;
    return directory ? `${directory}/_rels/${filename}.rels` : `_rels/${filename}.rels`;
}

function getDirectoryPath(path: string): string {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/");
}

function resolveZipPath(basePath: string, target: string): string {
    if (target.startsWith("/")) {
        return normalizeZipPath(target);
    }

    const initialParts = basePath ? basePath.split("/").filter(Boolean) : [];
    const targetParts = target.replace(/\\/g, "/").split("/");
    const parts = [...initialParts];

    for (const part of targetParts) {
        if (!part || part === ".") {
            continue;
        }

        if (part === "..") {
            parts.pop();
            continue;
        }

        parts.push(part);
    }

    return parts.join("/");
}

function normalizeZipPath(path: string): string {
    return path.replace(/^\/+/, "").replace(/\\/g, "/");
}
