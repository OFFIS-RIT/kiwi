import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import type { GraphBinaryLoader, GraphLoader } from "..";

type ODTOCRImage = {
    id: string;
    type: string;
    content: Uint8Array;
};

type ParsedODT = {
    blocks: ODTBlock[];
    images: ODTOCRImage[];
};

type ODTBlock =
    | { kind: "heading"; level: number; text: string }
    | { kind: "paragraph"; text: string }
    | { kind: "bullet"; text: string; level: number; ordered: boolean }
    | { kind: "table"; rows: string[][] }
    | { kind: "image"; id: string };

type InlinePiece = { kind: "text"; text: string } | { kind: "image"; id: string };

type InlineFormat = {
    bold: boolean;
    italic: boolean;
    strike: boolean;
    underline: boolean;
};

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

type ODTStyles = {
    inline: Map<string, InlineFormat>;
    lists: Map<string, Map<number, { ordered: boolean }>>;
};

type ODTManifest = Map<string, string>;

type ODTParseContext = {
    zip: JSZip;
    styles: ODTStyles;
    manifest: ODTManifest;
    images: ODTOCRImage[];
    nextImageId: () => string;
    ocr: boolean;
};

type ParagraphKind =
    | { kind: "paragraph" }
    | { kind: "heading"; level: number }
    | { kind: "bullet"; level: number; ordered: boolean };

const XML_MIME_TYPE = "application/xml";
const XML_ERROR_HANDLER = {
    warning: () => undefined,
    error: () => undefined,
    fatalError: () => undefined,
};
const IMAGE_FENCE_PATTERN = /^:::IMG-[^:]+:::$/;
const EMPTY_FORMAT: InlineFormat = {
    bold: false,
    italic: false,
    strike: false,
    underline: false,
};

export class ODTLoader implements GraphLoader {
    readonly filetype = "odt";

    constructor(private options: { loader: GraphBinaryLoader; ocr?: boolean }) {}

    async getText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        const parsed = await parseODT(content, Boolean(this.options.ocr));
        if (!this.options.ocr) {
            return renderMarkdown(parsed.blocks);
        }

        return renderMarkdown(parsed.blocks);
    }
}

async function parseODT(content: ArrayBuffer, ocr: boolean): Promise<ParsedODT> {
    const zip = await JSZip.loadAsync(content);
    const contentXml = await readZipText(zip, "content.xml");
    if (!contentXml) {
        return { blocks: [], images: [] };
    }

    const stylesXml = await readZipText(zip, "styles.xml");
    const manifestXml = await readZipText(zip, "META-INF/manifest.xml");
    const contentDocument = parseXml(contentXml);
    const stylesDocument = stylesXml ? parseXml(stylesXml) : null;
    const contentRoot = getDocumentRoot(contentDocument);
    if (!contentRoot) {
        return { blocks: [], images: [] };
    }

    const context: ODTParseContext = {
        zip,
        styles: parseODTStyles(contentRoot, stylesDocument ? getDocumentRoot(stylesDocument) : null),
        manifest: parseODTManifest(manifestXml),
        images: [],
        nextImageId: createImageIdFactory(),
        ocr,
    };

    const officeText = findOfficeText(contentRoot);
    if (!officeText) {
        return { blocks: [], images: [] };
    }

    return {
        blocks: await parseBlockChildren(officeText, context),
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

function findOfficeText(root: XMLNodeLike): XMLNodeLike | null {
    const body = findFirstDescendant(root, "body");
    return body ? findFirstDescendant(body, "text") : null;
}

async function parseBlockChildren(parent: XMLNodeLike, context: ODTParseContext): Promise<ODTBlock[]> {
    const blocks: ODTBlock[] = [];

    for (const child of getChildElements(parent)) {
        switch (getLocalName(child)) {
            case "h":
                blocks.push(
                    ...(await parseParagraphNode(child, context, { kind: "heading", level: getHeadingLevel(child) }))
                );
                break;
            case "p":
                blocks.push(...(await parseParagraphNode(child, context, { kind: "paragraph" })));
                break;
            case "list":
                blocks.push(...(await parseList(child, context, 0)));
                break;
            case "table": {
                const table = await parseTable(child, context);
                if (table) {
                    blocks.push(table);
                }
                break;
            }
            case "section":
            case "index-body":
            case "tracked-changes":
                blocks.push(...(await parseBlockChildren(child, context)));
                break;
            case "frame": {
                const framePieces = await collectInlinePieces(child, context, EMPTY_FORMAT, null);
                for (const piece of framePieces) {
                    if (piece.kind === "image") {
                        blocks.push({ kind: "image", id: piece.id });
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    return blocks;
}

async function parseParagraphNode(
    node: XMLNodeLike,
    context: ODTParseContext,
    paragraphKind: ParagraphKind
): Promise<ODTBlock[]> {
    const pieces = await collectInlinePieces(node, context, EMPTY_FORMAT, null);
    if (pieces.length === 0) {
        return [];
    }

    const blocks: ODTBlock[] = [];
    let textBuffer = "";

    const flushText = () => {
        const text = normalizeInlineText(textBuffer);
        textBuffer = "";
        if (!text) {
            return;
        }

        switch (paragraphKind.kind) {
            case "heading":
                blocks.push({ kind: "heading", level: paragraphKind.level, text });
                break;
            case "bullet":
                blocks.push({ kind: "bullet", level: paragraphKind.level, ordered: paragraphKind.ordered, text });
                break;
            case "paragraph":
                blocks.push({ kind: "paragraph", text });
                break;
        }
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

async function parseList(list: XMLNodeLike, context: ODTParseContext, level: number): Promise<ODTBlock[]> {
    const blocks: ODTBlock[] = [];
    const styleName = getAttribute(list, "text:style-name", "style-name");
    const ordered = isOrderedList(context.styles.lists, styleName, level);

    for (const child of getChildElements(list)) {
        switch (getLocalName(child)) {
            case "list-item":
            case "list-header":
                blocks.push(...(await parseListItem(child, context, level, ordered)));
                break;
            default:
                break;
        }
    }

    return blocks;
}

async function parseListItem(
    item: XMLNodeLike,
    context: ODTParseContext,
    level: number,
    ordered: boolean
): Promise<ODTBlock[]> {
    const blocks: ODTBlock[] = [];

    for (const child of getChildElements(item)) {
        switch (getLocalName(child)) {
            case "p":
            case "h":
                blocks.push(...(await parseParagraphNode(child, context, { kind: "bullet", level, ordered })));
                break;
            case "list":
                blocks.push(...(await parseList(child, context, level + 1)));
                break;
            case "table": {
                const table = await parseTable(child, context);
                if (table) {
                    blocks.push(table);
                }
                break;
            }
            case "section":
                blocks.push(...(await parseBlockChildren(child, context)));
                break;
            default:
                break;
        }
    }

    return blocks;
}

async function parseTable(table: XMLNodeLike, context: ODTParseContext): Promise<ODTBlock | null> {
    const rows = await extractTableRows(table, context);
    const nonEmptyRows = rows.filter((row) => row.length > 0 && row.some((cell) => cell.length > 0));
    if (nonEmptyRows.length === 0) {
        return null;
    }

    return { kind: "table", rows: nonEmptyRows };
}

async function extractTableRows(table: XMLNodeLike, context: ODTParseContext): Promise<string[][]> {
    const rows: string[][] = [];

    for (const child of getChildElements(table)) {
        switch (getLocalName(child)) {
            case "table-header-rows":
                rows.push(...(await extractTableRows(child, context)));
                break;
            case "table-row": {
                const repeatCount = getRepeatedCount(child, "table:number-rows-repeated", "number-rows-repeated");
                const row = await extractTableRow(child, context);
                for (let index = 0; index < repeatCount; index += 1) {
                    rows.push([...row]);
                }
                break;
            }
            default:
                break;
        }
    }

    return rows;
}

async function extractTableRow(row: XMLNodeLike, context: ODTParseContext): Promise<string[]> {
    const cells: string[] = [];

    for (const child of getChildElements(row)) {
        const name = getLocalName(child);
        if (name !== "table-cell" && name !== "covered-table-cell") {
            continue;
        }

        const repeatCount = getRepeatedCount(child, "table:number-columns-repeated", "number-columns-repeated");
        const value = name === "covered-table-cell" ? "" : await extractTableCellText(child, context);
        for (let index = 0; index < repeatCount; index += 1) {
            cells.push(value);
        }
    }

    while (cells.length > 0 && cells[cells.length - 1] === "") {
        cells.pop();
    }

    return cells;
}

async function extractTableCellText(cell: XMLNodeLike, context: ODTParseContext): Promise<string> {
    const parts: string[] = [];

    for (const child of getChildElements(cell)) {
        switch (getLocalName(child)) {
            case "p":
            case "h": {
                const text = normalizeInlineText(await extractInlineText(child, context));
                if (text) {
                    parts.push(text.replace(/\s*\n\s*/g, " "));
                }
                break;
            }
            case "list": {
                const listItems = await extractListTexts(child, context);
                if (listItems.length > 0) {
                    parts.push(listItems.join(" "));
                }
                break;
            }
            default:
                break;
        }
    }

    return normalizeInlineText(parts.join(" "));
}

async function extractListTexts(list: XMLNodeLike, context: ODTParseContext): Promise<string[]> {
    const parts: string[] = [];

    for (const child of getChildElements(list)) {
        if (getLocalName(child) !== "list-item") {
            continue;
        }

        for (const itemChild of getChildElements(child)) {
            switch (getLocalName(itemChild)) {
                case "p":
                case "h": {
                    const text = normalizeInlineText(await extractInlineText(itemChild, context));
                    if (text) {
                        parts.push(text.replace(/\s*\n\s*/g, " "));
                    }
                    break;
                }
                case "list": {
                    parts.push(...(await extractListTexts(itemChild, context)));
                    break;
                }
                default:
                    break;
            }
        }
    }

    return parts;
}

async function extractInlineText(node: XMLNodeLike, context: ODTParseContext): Promise<string> {
    const pieces = await collectInlinePieces(node, context, EMPTY_FORMAT, null);
    return pieces
        .filter((piece): piece is Extract<InlinePiece, { kind: "text" }> => piece.kind === "text")
        .map((piece) => piece.text)
        .join("");
}

async function collectInlinePieces(
    node: XMLNodeLike,
    context: ODTParseContext,
    format: InlineFormat,
    hyperlinkTarget: string | null
): Promise<InlinePiece[]> {
    const pieces: InlinePiece[] = [];

    for (const child of getChildNodes(node)) {
        if (isTextNode(child)) {
            const value = child.textContent ?? "";
            if (value) {
                pieces.push({ kind: "text", text: formatInlineText(value, format, hyperlinkTarget, context.ocr) });
            }
            continue;
        }

        if (!isElementNode(child)) {
            continue;
        }

        pieces.push(...(await parseInlineElement(child, context, format, hyperlinkTarget)));
    }

    return mergeInlineTextPieces(pieces);
}

async function parseInlineElement(
    node: XMLNodeLike,
    context: ODTParseContext,
    format: InlineFormat,
    hyperlinkTarget: string | null
): Promise<InlinePiece[]> {
    switch (getLocalName(node)) {
        case "span": {
            const styleName = getAttribute(node, "text:style-name", "style-name");
            const nextFormat = mergeFormats(format, styleName ? context.styles.inline.get(styleName) : undefined);
            return collectInlinePieces(node, context, nextFormat, hyperlinkTarget);
        }
        case "a": {
            const target = getAttribute(node, "xlink:href", "href") ?? hyperlinkTarget;
            return collectInlinePieces(node, context, format, target);
        }
        case "line-break":
            return [{ kind: "text", text: "\n" }];
        case "tab":
            return [{ kind: "text", text: "\t" }];
        case "s": {
            const countValue = getAttribute(node, "text:c", "c");
            const count = Number.isFinite(Number(countValue)) && Number(countValue) > 0 ? Number(countValue) : 1;
            return [{ kind: "text", text: " ".repeat(count) }];
        }
        case "image": {
            if (!context.ocr) {
                return [];
            }

            const imageId = await extractImageId(node, context);
            return imageId ? [{ kind: "image", id: imageId }] : [];
        }
        case "frame":
        case "text-box":
        case "p":
        case "h":
        case "section":
            return collectInlinePieces(node, context, format, hyperlinkTarget);
        default:
            return collectInlinePieces(node, context, format, hyperlinkTarget);
    }
}

async function extractImageId(node: XMLNodeLike, context: ODTParseContext): Promise<string | null> {
    const href = getAttribute(node, "xlink:href", "href");
    if (!href || /^https?:\/\//i.test(href)) {
        return null;
    }

    const path = normalizeZipPath(href);
    const file = context.zip.file(path);
    if (!file) {
        return null;
    }

    const id = context.nextImageId();
    const content = await file.async("uint8array");
    context.images.push({
        id,
        type: getMimeTypeForPath(context.manifest, path),
        content,
    });

    return id;
}

function getHeadingLevel(node: XMLNodeLike): number {
    const value = getAttribute(node, "text:outline-level", "outline-level");
    const level = Number(value);
    return Number.isFinite(level) && level > 0 ? clampHeadingLevel(level) : 1;
}

function isOrderedList(styles: ODTStyles["lists"], styleName: string | null, level: number): boolean {
    if (!styleName) {
        return false;
    }

    const levels = styles.get(styleName);
    return levels?.get(level + 1)?.ordered ?? levels?.get(1)?.ordered ?? false;
}

function getRepeatedCount(node: XMLNodeLike, ...attributeNames: string[]): number {
    const value = getAttribute(node, ...attributeNames);
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseODTStyles(contentRoot: XMLNodeLike, stylesRoot: XMLNodeLike | null): ODTStyles {
    const inlineDefinitions = new Map<string, { format: InlineFormat; parent: string | null }>();
    const listStyles = new Map<string, Map<number, { ordered: boolean }>>();

    for (const root of [contentRoot, stylesRoot]) {
        if (!root) {
            continue;
        }

        for (const node of findDescendants(root, "style")) {
            const family = getAttribute(node, "style:family", "family");
            const name = getAttribute(node, "style:name", "name");
            if (!name || family !== "text") {
                continue;
            }

            inlineDefinitions.set(name, {
                format: parseInlineFormat(node),
                parent: getAttribute(node, "style:parent-style-name", "parent-style-name"),
            });
        }

        for (const node of findDescendants(root, "list-style")) {
            const name = getAttribute(node, "style:name", "text:style-name", "name", "style-name");
            if (!name) {
                continue;
            }

            const levels = new Map<number, { ordered: boolean }>();
            for (const child of getChildElements(node)) {
                const childName = getLocalName(child);
                if (
                    childName !== "list-level-style-bullet" &&
                    childName !== "list-level-style-number" &&
                    childName !== "list-level-style-image"
                ) {
                    continue;
                }

                const levelValue = getAttribute(child, "text:level", "level");
                const level = Number.isFinite(Number(levelValue)) && Number(levelValue) > 0 ? Number(levelValue) : 1;
                levels.set(level, { ordered: childName === "list-level-style-number" });
            }

            if (levels.size > 0) {
                listStyles.set(name, levels);
            }
        }
    }

    const resolvedInline = new Map<string, InlineFormat>();
    const resolveStyle = (name: string): InlineFormat => {
        const existing = resolvedInline.get(name);
        if (existing) {
            return existing;
        }

        const definition = inlineDefinitions.get(name);
        if (!definition) {
            return EMPTY_FORMAT;
        }

        const merged = mergeFormats(
            definition.parent ? resolveStyle(definition.parent) : EMPTY_FORMAT,
            definition.format
        );
        resolvedInline.set(name, merged);
        return merged;
    };

    for (const name of inlineDefinitions.keys()) {
        resolvedInline.set(name, resolveStyle(name));
    }

    return {
        inline: resolvedInline,
        lists: listStyles,
    };
}

function parseInlineFormat(style: XMLNodeLike): InlineFormat {
    const textProperties = findFirstChild(style, "text-properties");
    if (!textProperties) {
        return EMPTY_FORMAT;
    }

    const fontWeight = getAttribute(textProperties, "fo:font-weight", "font-weight") ?? "";
    const fontStyle = getAttribute(textProperties, "fo:font-style", "font-style") ?? "";
    const textLineThrough =
        getAttribute(textProperties, "style:text-line-through-style", "text-line-through-style") ?? "";
    const textUnderline = getAttribute(textProperties, "style:text-underline-style", "text-underline-style") ?? "";

    return {
        bold: fontWeight.toLowerCase() === "bold",
        italic: fontStyle.toLowerCase() === "italic",
        strike: textLineThrough.toLowerCase() !== "" && textLineThrough.toLowerCase() !== "none",
        underline: textUnderline.toLowerCase() !== "" && textUnderline.toLowerCase() !== "none",
    };
}

function mergeFormats(base: InlineFormat, overlay?: Partial<InlineFormat>): InlineFormat {
    if (!overlay) {
        return base;
    }

    return {
        bold: base.bold || Boolean(overlay.bold),
        italic: base.italic || Boolean(overlay.italic),
        strike: base.strike || Boolean(overlay.strike),
        underline: base.underline || Boolean(overlay.underline),
    };
}

function parseODTManifest(xml: string | null): ODTManifest {
    const manifest: ODTManifest = new Map();
    if (!xml) {
        return manifest;
    }

    const document = parseXml(xml);
    const root = getDocumentRoot(document);
    if (!root) {
        return manifest;
    }

    for (const node of findDescendants(root, "file-entry")) {
        const path = getAttribute(node, "manifest:full-path", "full-path");
        const mediaType = getAttribute(node, "manifest:media-type", "media-type");
        if (!path || !mediaType) {
            continue;
        }

        manifest.set(normalizeZipPath(path), mediaType);
    }

    return manifest;
}

function getMimeTypeForPath(manifest: ODTManifest, path: string): string {
    const normalizedPath = normalizeZipPath(path);
    const manifestType = manifest.get(normalizedPath);
    if (manifestType) {
        return manifestType;
    }

    const extension = normalizedPath.split(".").at(-1)?.toLowerCase();
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

function renderMarkdown(blocks: ODTBlock[]): string {
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

function formatInlineText(
    value: string,
    format: InlineFormat,
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

function getChildNodes(node: XMLNodeLike): XMLNodeLike[] {
    const childNodes = node.childNodes;
    if (!childNodes) {
        return [];
    }

    const children: XMLNodeLike[] = [];
    for (let index = 0; index < childNodes.length; index += 1) {
        const child = childNodes[index];
        if (isNodeLike(child)) {
            children.push(child);
        }
    }

    return children;
}

function getChildElements(node: XMLNodeLike): XMLNodeLike[] {
    return getChildNodes(node).filter(isElementNode);
}

function isNodeLike(value: unknown): value is XMLNodeLike {
    return typeof value === "object" && value !== null;
}

function isElementNode(value: unknown): value is XMLNodeLike {
    return isNodeLike(value) && (value as XMLNodeLike).nodeType === 1;
}

function isTextNode(value: unknown): value is XMLNodeLike {
    return isNodeLike(value) && ((value as XMLNodeLike).nodeType === 3 || (value as XMLNodeLike).nodeType === 4);
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

function normalizeZipPath(path: string): string {
    return path.replace(/^\/+/, "").replace(/\\/g, "/");
}
