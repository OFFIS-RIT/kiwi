import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import type { GraphBinaryLoader, GraphLoader } from "..";

type ODPOCRImage = {
    id: string;
    type: string;
    content: Uint8Array;
};

type ParsedODP = {
    slides: SlideContent[];
    images: ODPOCRImage[];
};

type SlideContent = {
    index: number;
    hasTitle: boolean;
    blocks: SlideBlock[];
};

type SlideBlock =
    | { kind: "heading"; text: string }
    | { kind: "paragraph"; text: string }
    | { kind: "bullet"; text: string; level: number; ordered: boolean }
    | { kind: "table"; rows: string[][] }
    | { kind: "image"; id: string };

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

type ODPStyles = {
    lists: Map<string, Map<number, { ordered: boolean }>>;
};

type ODPManifest = Map<string, string>;

type ODPParseContext = {
    zip: JSZip;
    styles: ODPStyles;
    manifest: ODPManifest;
    images: ODPOCRImage[];
    nextImageId: () => string;
    ocr: boolean;
};

const XML_MIME_TYPE = "application/xml";
const XML_ERROR_HANDLER = {
    warning: () => undefined,
    error: () => undefined,
    fatalError: () => undefined,
};

export class ODPLoader implements GraphLoader {
    readonly filetype = "odp";

    constructor(private options: { loader: GraphBinaryLoader; ocr?: boolean }) {}

    async getText(): Promise<string> {
        const content = await this.options.loader.getBinary();
        const parsed = await parseODP(content, this.options.ocr ?? false);
        if (!this.options.ocr) {
            return renderMarkdown(parsed.slides);
        }

        return renderMarkdown(parsed.slides);
    }
}

async function parseODP(content: ArrayBuffer, ocr: boolean): Promise<ParsedODP> {
    const zip = await JSZip.loadAsync(content);
    const contentXml = await readZipText(zip, "content.xml");
    if (!contentXml) {
        return { slides: [], images: [] };
    }

    const stylesXml = await readZipText(zip, "styles.xml");
    const manifestXml = await readZipText(zip, "META-INF/manifest.xml");
    const contentDocument = parseXml(contentXml);
    const contentRoot = getDocumentRoot(contentDocument);
    if (!contentRoot) {
        return { slides: [], images: [] };
    }

    const stylesRoot = stylesXml ? getDocumentRoot(parseXml(stylesXml)) : null;
    const context: ODPParseContext = {
        zip,
        styles: parseODPStyles(contentRoot, stylesRoot),
        manifest: parseODPManifest(manifestXml),
        images: [],
        nextImageId: createImageIdFactory(),
        ocr,
    };

    const presentation = findPresentationRoot(contentRoot);
    if (!presentation) {
        return { slides: [], images: [] };
    }

    const slides: SlideContent[] = [];
    const pages = getChildElements(presentation).filter((node) => getLocalName(node) === "page");
    for (const [index, page] of pages.entries()) {
        const slide = await parseSlide(page, index, context);
        if (slide.blocks.length > 0) {
            slides.push(slide);
        }
    }

    return {
        slides,
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

function findPresentationRoot(root: XMLNodeLike): XMLNodeLike | null {
    const body = findFirstDescendant(root, "body");
    return body ? findFirstDescendant(body, "presentation") : null;
}

async function parseSlide(page: XMLNodeLike, index: number, context: ODPParseContext): Promise<SlideContent> {
    const blocks = await parseSlideContainer(page, context);
    const hasTitle = blocks.some((block) => block.kind === "heading");
    return { index, hasTitle, blocks };
}

async function parseSlideContainer(node: XMLNodeLike, context: ODPParseContext): Promise<SlideBlock[]> {
    const blocks: SlideBlock[] = [];

    for (const child of getChildElements(node)) {
        switch (getLocalName(child)) {
            case "frame":
                blocks.push(...(await parseFrame(child, context)));
                break;
            case "g":
                blocks.push(...(await parseSlideContainer(child, context)));
                break;
            case "custom-shape":
            case "rect":
            case "ellipse":
            case "line":
            case "connector":
                blocks.push(...(await parseShape(child, context, null)));
                break;
            case "page-thumbnail":
            case "notes":
                break;
            default:
                break;
        }
    }

    return blocks;
}

async function parseFrame(frame: XMLNodeLike, context: ODPParseContext): Promise<SlideBlock[]> {
    const frameClass = getAttribute(frame, "presentation:class", "class");
    return parseFrameChildren(frame, context, frameClass);
}

async function parseFrameChildren(
    frame: XMLNodeLike,
    context: ODPParseContext,
    frameClass: string | null
): Promise<SlideBlock[]> {
    const blocks: SlideBlock[] = [];

    for (const child of getChildElements(frame)) {
        switch (getLocalName(child)) {
            case "text-box":
                blocks.push(...(await parseTextBox(child, context, frameClass)));
                break;
            case "image": {
                if (!context.ocr) {
                    break;
                }

                const imageId = await extractImageId(child, context);
                if (imageId) {
                    blocks.push({ kind: "image", id: imageId });
                }
                break;
            }
            case "table": {
                const table = await parseTable(child, context);
                if (table) {
                    blocks.push(table);
                }
                break;
            }
            case "frame":
                blocks.push(...(await parseFrame(child, context)));
                break;
            case "g":
                blocks.push(...(await parseSlideContainer(child, context)));
                break;
            case "custom-shape":
            case "rect":
            case "ellipse":
            case "line":
            case "connector":
                blocks.push(...(await parseShape(child, context, frameClass)));
                break;
            default:
                break;
        }
    }

    return blocks;
}

async function parseShape(
    shape: XMLNodeLike,
    context: ODPParseContext,
    inheritedClass: string | null
): Promise<SlideBlock[]> {
    const shapeClass = getAttribute(shape, "presentation:class", "class") ?? inheritedClass;
    const blocks: SlideBlock[] = [];

    for (const child of getChildElements(shape)) {
        switch (getLocalName(child)) {
            case "text-box":
                blocks.push(...(await parseTextBox(child, context, shapeClass)));
                break;
            case "table": {
                const table = await parseTable(child, context);
                if (table) {
                    blocks.push(table);
                }
                break;
            }
            case "image": {
                if (!context.ocr) {
                    break;
                }

                const imageId = await extractImageId(child, context);
                if (imageId) {
                    blocks.push({ kind: "image", id: imageId });
                }
                break;
            }
            default:
                break;
        }
    }

    return blocks;
}

async function parseTextBox(
    textBox: XMLNodeLike,
    context: ODPParseContext,
    frameClass: string | null
): Promise<SlideBlock[]> {
    if (isTitleClass(frameClass)) {
        const titleParts = getChildElements(textBox)
            .filter((node) => {
                const name = getLocalName(node);
                return name === "p" || name === "h";
            })
            .map((paragraph) => normalizeWhitespace(extractNodeText(paragraph).replace(/\s*\n\s*/g, " ")))
            .filter(Boolean);

        if (titleParts.length > 0) {
            return [{ kind: "heading", text: normalizeWhitespace(titleParts.join(" ")) }];
        }
    }

    return parseTextContainer(textBox, context, frameClass);
}

async function parseTextContainer(
    container: XMLNodeLike,
    context: ODPParseContext,
    frameClass: string | null
): Promise<SlideBlock[]> {
    const blocks: SlideBlock[] = [];

    for (const child of getChildElements(container)) {
        switch (getLocalName(child)) {
            case "h": {
                const text = normalizeWhitespace(extractNodeText(child).replace(/\s*\n\s*/g, " "));
                if (text) {
                    blocks.push({ kind: "heading", text });
                }
                break;
            }
            case "p": {
                const text = normalizeWhitespace(extractNodeText(child).replace(/\s*\n\s*/g, " "));
                if (!text) {
                    break;
                }

                blocks.push(isTitleClass(frameClass) ? { kind: "heading", text } : { kind: "paragraph", text });
                break;
            }
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
                blocks.push(...(await parseTextContainer(child, context, frameClass)));
                break;
            default:
                break;
        }
    }

    return blocks;
}

async function parseList(list: XMLNodeLike, context: ODPParseContext, level: number): Promise<SlideBlock[]> {
    const blocks: SlideBlock[] = [];
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
    context: ODPParseContext,
    level: number,
    ordered: boolean
): Promise<SlideBlock[]> {
    const blocks: SlideBlock[] = [];

    for (const child of getChildElements(item)) {
        switch (getLocalName(child)) {
            case "p":
            case "h": {
                const text = normalizeWhitespace(extractNodeText(child).replace(/\s*\n\s*/g, " "));
                if (text) {
                    blocks.push({ kind: "bullet", text, level, ordered });
                }
                break;
            }
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
            default:
                break;
        }
    }

    return blocks;
}

async function parseTable(table: XMLNodeLike, context: ODPParseContext): Promise<SlideBlock | null> {
    const rows = await extractTableRows(table, context);
    const nonEmptyRows = rows.filter((row) => row.length > 0 && row.some((cell) => cell.length > 0));
    if (nonEmptyRows.length === 0) {
        return null;
    }

    return { kind: "table", rows: nonEmptyRows };
}

async function extractTableRows(table: XMLNodeLike, context: ODPParseContext): Promise<string[][]> {
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

async function extractTableRow(row: XMLNodeLike, context: ODPParseContext): Promise<string[]> {
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

async function extractTableCellText(cell: XMLNodeLike, _context: ODPParseContext): Promise<string> {
    const parts: string[] = [];

    for (const child of getChildElements(cell)) {
        switch (getLocalName(child)) {
            case "p":
            case "h": {
                const text = normalizeWhitespace(extractNodeText(child).replace(/\s*\n\s*/g, " "));
                if (text) {
                    parts.push(text);
                }
                break;
            }
            case "list": {
                const values = await extractListTexts(child);
                if (values.length > 0) {
                    parts.push(values.join(" "));
                }
                break;
            }
            case "section": {
                const values = await extractSectionTexts(child);
                if (values.length > 0) {
                    parts.push(values.join(" "));
                }
                break;
            }
            default:
                break;
        }
    }

    return normalizeWhitespace(parts.join(" "));
}

async function extractListTexts(list: XMLNodeLike): Promise<string[]> {
    const values: string[] = [];

    for (const child of getChildElements(list)) {
        if (getLocalName(child) !== "list-item") {
            continue;
        }

        for (const itemChild of getChildElements(child)) {
            switch (getLocalName(itemChild)) {
                case "p":
                case "h": {
                    const text = normalizeWhitespace(extractNodeText(itemChild).replace(/\s*\n\s*/g, " "));
                    if (text) {
                        values.push(text);
                    }
                    break;
                }
                case "list":
                    values.push(...(await extractListTexts(itemChild)));
                    break;
                default:
                    break;
            }
        }
    }

    return values;
}

async function extractSectionTexts(section: XMLNodeLike): Promise<string[]> {
    const values: string[] = [];

    for (const child of getChildElements(section)) {
        switch (getLocalName(child)) {
            case "p":
            case "h": {
                const text = normalizeWhitespace(extractNodeText(child).replace(/\s*\n\s*/g, " "));
                if (text) {
                    values.push(text);
                }
                break;
            }
            case "list":
                values.push(...(await extractListTexts(child)));
                break;
            default:
                break;
        }
    }

    return values;
}

async function extractImageId(node: XMLNodeLike, context: ODPParseContext): Promise<string | null> {
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

function extractNodeText(node: XMLNodeLike): string {
    if (isTextNode(node)) {
        return node.textContent ?? "";
    }

    if (!isElementNode(node)) {
        return "";
    }

    const name = getLocalName(node);
    if (name === "line-break") {
        return "\n";
    }

    if (name === "tab") {
        return "\t";
    }

    if (name === "s") {
        const countValue = getAttribute(node, "text:c", "c");
        const count = Number.isFinite(Number(countValue)) && Number(countValue) > 0 ? Number(countValue) : 1;
        return " ".repeat(count);
    }

    let text = "";
    for (const child of getChildNodes(node)) {
        text += extractNodeText(child);
    }

    return text;
}

function isTitleClass(value: string | null): boolean {
    return value === "title" || value === "subtitle" || value === "ctrTitle";
}

function parseODPStyles(contentRoot: XMLNodeLike, stylesRoot: XMLNodeLike | null): ODPStyles {
    const lists = new Map<string, Map<number, { ordered: boolean }>>();

    for (const root of [contentRoot, stylesRoot]) {
        if (!root) {
            continue;
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
                lists.set(name, levels);
            }
        }
    }

    return { lists };
}

function parseODPManifest(xml: string | null): ODPManifest {
    const manifest: ODPManifest = new Map();
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

function isOrderedList(styles: ODPStyles["lists"], styleName: string | null, level: number): boolean {
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

function getMimeTypeForPath(manifest: ODPManifest, path: string): string {
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

function renderMarkdown(slides: SlideContent[]): string {
    const rendered = slides
        .map((slide) => {
            if (slide.blocks.length === 0) {
                return "";
            }

            const blocks: string[] = [];
            if (!slide.hasTitle) {
                blocks.push(`## Slide ${slide.index + 1}`);
            }

            for (const block of slide.blocks) {
                switch (block.kind) {
                    case "heading":
                        blocks.push(`# ${block.text}`);
                        break;
                    case "paragraph":
                        blocks.push(block.text);
                        break;
                    case "bullet": {
                        const indent = "  ".repeat(Math.max(0, block.level));
                        const marker = block.ordered ? "1." : "-";
                        blocks.push(`${indent}${marker} ${block.text}`);
                        break;
                    }
                    case "image":
                        blocks.push(`:::IMG-${block.id}:::`);
                        break;
                    case "table":
                        blocks.push(rowsToMarkdown(block.rows));
                        break;
                }
            }

            return blocks
                .map((block) => block.trim())
                .filter(Boolean)
                .join("\n\n");
        })
        .filter(Boolean);

    return rendered.join("\n\n");
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
        const nextRow = row.map((cell) => escapeMarkdownTableCell(normalizeWhitespace(cell)));
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

function parseXml(xml: string): XMLDocumentLike {
    return new DOMParser({ errorHandler: XML_ERROR_HANDLER }).parseFromString(
        xml,
        XML_MIME_TYPE
    ) as unknown as XMLDocumentLike;
}

function getDocumentRoot(document: XMLDocumentLike): XMLNodeLike | null {
    return isElementNode(document.documentElement) ? document.documentElement : null;
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

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}
