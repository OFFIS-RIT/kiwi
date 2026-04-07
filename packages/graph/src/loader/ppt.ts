import { DOMParser } from "@xmldom/xmldom";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import JSZip from "jszip";
import type { GraphBinaryLoader, GraphLoader } from "..";
import { processOCRImages } from "../lib/ocr-image";

type PPTOCRImage = {
    id: string;
    type: string;
    content: Uint8Array;
};

type ParsedPPT = {
    slides: SlideContent[];
    images: PPTOCRImage[];
};

type SlideContent = {
    index: number;
    hasTitle: boolean;
    blocks: SlideBlock[];
};

type SlideBlock =
    | { kind: "heading"; text: string }
    | { kind: "paragraph"; text: string }
    | { kind: "bullet"; text: string }
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

type ContentTypes = {
    defaults: Map<string, string>;
    overrides: Map<string, string>;
};

const XML_MIME_TYPE = "application/xml";
const XML_ERROR_HANDLER = {
    warning: () => undefined,
    error: () => undefined,
    fatalError: () => undefined,
};

export class PPTXLoader implements GraphLoader {
    readonly filetype = "pptx";
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
        const parsed = await parsePPT(content, false);
        return renderMarkdown(parsed.slides);
    }

    private async getOCRText(): Promise<string> {
        const model = this.options.model;
        const storage = this.options.storage;
        if (!model || !storage) {
            throw new Error("PPTX OCR requires an image model and storage configuration");
        }

        const content = await this.options.loader.getBinary();
        const parsed = await parsePPT(content, true);
        const markdown = renderMarkdown(parsed.slides);
        return processOCRImages(markdown, parsed.images, model, storage);
    }
}

async function parsePPT(content: ArrayBuffer, ocr: boolean): Promise<ParsedPPT> {
    const zip = await JSZip.loadAsync(content);
    const contentTypes = parseContentTypes(await readZipText(zip, "[Content_Types].xml"));
    const slidePaths = await getSlidePaths(zip);
    const images: PPTOCRImage[] = [];
    const slides: SlideContent[] = [];
    let imageCounter = 0;

    for (const [index, slidePath] of slidePaths.entries()) {
        const relationships = await getRelationshipsForPart(zip, slidePath);
        const slide = await parseSlide(
            zip,
            slidePath,
            index,
            relationships,
            contentTypes,
            images,
            () => {
                imageCounter += 1;
                return `img-${imageCounter}`;
            },
            ocr
        );

        if (slide.blocks.length > 0) {
            slides.push(slide);
        }
    }

    return { slides, images };
}

async function getSlidePaths(zip: JSZip): Promise<string[]> {
    const presentationXml = await readZipText(zip, "ppt/presentation.xml");
    const presentationRelationships = await getRelationshipsForPart(zip, "ppt/presentation.xml");
    if (presentationXml) {
        const document = parseXml(presentationXml);
        const root = getDocumentRoot(document);
        const slideIdList = root ? findFirstChild(root, "sldIdLst") : null;
        const orderedPaths = slideIdList
            ? getChildElements(slideIdList)
                  .filter((node) => getLocalName(node) === "sldId")
                  .map((node) => getAttribute(node, "r:id", "id"))
                  .map((relationshipId) =>
                      relationshipId ? (presentationRelationships.get(relationshipId) ?? null) : null
                  )
                  .filter((path): path is string => typeof path === "string")
            : [];

        if (orderedPaths.length > 0) {
            return orderedPaths;
        }
    }

    return Object.keys(zip.files)
        .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
        .sort(compareSlidePaths);
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
        if (!id || !target || targetMode === "External") {
            continue;
        }

        relationships.set(id, resolveZipPath(getDirectoryPath(partPath), target));
    }

    return relationships;
}

async function parseSlide(
    zip: JSZip,
    slidePath: string,
    index: number,
    relationships: Map<string, string>,
    contentTypes: ContentTypes,
    images: PPTOCRImage[],
    nextImageId: () => string,
    ocr: boolean
): Promise<SlideContent> {
    const slideXml = await readZipText(zip, slidePath);
    if (!slideXml) {
        return { index, hasTitle: false, blocks: [] };
    }

    const document = parseXml(slideXml);
    const root = getDocumentRoot(document);
    const shapeTree = root ? findFirstDescendant(root, "spTree") : null;
    if (!shapeTree) {
        return { index, hasTitle: false, blocks: [] };
    }

    const blocks: SlideBlock[] = [];
    let hasTitle = false;

    for (const node of getChildElements(shapeTree)) {
        const name = getLocalName(node);
        if (name === "nvGrpSpPr" || name === "grpSpPr") {
            continue;
        }

        const nextBlocks = await parseSlideNode(zip, node, relationships, contentTypes, images, nextImageId, ocr);
        for (const block of nextBlocks) {
            if (block.kind === "heading") {
                hasTitle = true;
            }

            blocks.push(block);
        }
    }

    return { index, hasTitle, blocks };
}

async function parseSlideNode(
    zip: JSZip,
    node: XMLNodeLike,
    relationships: Map<string, string>,
    contentTypes: ContentTypes,
    images: PPTOCRImage[],
    nextImageId: () => string,
    ocr: boolean
): Promise<SlideBlock[]> {
    switch (getLocalName(node)) {
        case "sp":
            return parseShape(node);
        case "pic":
            return ocr ? parsePicture(zip, node, relationships, contentTypes, images, nextImageId) : [];
        case "graphicFrame":
            return parseGraphicFrame(node);
        case "grpSp": {
            const blocks: SlideBlock[] = [];
            for (const child of getChildElements(node)) {
                const childName = getLocalName(child);
                if (childName === "nvGrpSpPr" || childName === "grpSpPr") {
                    continue;
                }

                blocks.push(
                    ...(await parseSlideNode(zip, child, relationships, contentTypes, images, nextImageId, ocr))
                );
            }

            return blocks;
        }
        default:
            return [];
    }
}

function parseShape(shape: XMLNodeLike): SlideBlock[] {
    const textBody = findFirstDescendant(shape, "txBody");
    if (!textBody) {
        return [];
    }

    const paragraphs = getChildElements(textBody)
        .filter((node) => getLocalName(node) === "p")
        .map((paragraph) => ({
            text: normalizeWhitespace(extractParagraphText(paragraph).replace(/\s*\n\s*/g, " ")),
            isBullet: isBulletParagraph(paragraph),
        }))
        .filter((paragraph) => paragraph.text.length > 0);

    if (paragraphs.length === 0) {
        return [];
    }

    if (isTitleShape(shape)) {
        return [
            {
                kind: "heading",
                text: normalizeWhitespace(paragraphs.map((paragraph) => paragraph.text).join(" ")),
            },
        ];
    }

    return paragraphs.map((paragraph) => ({
        kind: paragraph.isBullet ? "bullet" : "paragraph",
        text: paragraph.text,
    }));
}

async function parsePicture(
    zip: JSZip,
    picture: XMLNodeLike,
    relationships: Map<string, string>,
    contentTypes: ContentTypes,
    images: PPTOCRImage[],
    nextImageId: () => string
): Promise<SlideBlock[]> {
    const blip = findFirstDescendant(picture, "blip");
    const relationshipId = blip ? getAttribute(blip, "r:embed", "embed") : null;
    if (!relationshipId) {
        return [];
    }

    const targetPath = relationships.get(relationshipId);
    if (!targetPath) {
        return [];
    }

    const file = zip.file(targetPath);
    if (!file) {
        return [];
    }

    const id = nextImageId();
    const content = await file.async("uint8array");

    images.push({
        id,
        type: getMimeTypeForPath(contentTypes, targetPath),
        content,
    });

    return [{ kind: "image", id }];
}

function parseGraphicFrame(frame: XMLNodeLike): SlideBlock[] {
    const table = findFirstDescendant(frame, "tbl");
    if (!table) {
        return [];
    }

    const rows = getChildElements(table)
        .filter((node) => getLocalName(node) === "tr")
        .map((row) =>
            getChildElements(row)
                .filter((node) => getLocalName(node) === "tc")
                .map((cell) => extractTableCellText(cell))
        )
        .filter((row) => row.length > 0);

    if (rows.length === 0) {
        return [];
    }

    return [{ kind: "table", rows }];
}

function extractTableCellText(cell: XMLNodeLike): string {
    const textBody = findFirstDescendant(cell, "txBody");
    if (!textBody) {
        return "";
    }

    const parts = getChildElements(textBody)
        .filter((node) => getLocalName(node) === "p")
        .map((paragraph) => normalizeWhitespace(extractParagraphText(paragraph).replace(/\s*\n\s*/g, " ")))
        .filter(Boolean);

    return normalizeWhitespace(parts.join(" "));
}

function extractParagraphText(paragraph: XMLNodeLike): string {
    return extractNodeText(paragraph);
}

function extractNodeText(node: XMLNodeLike): string {
    const name = getLocalName(node);
    if (name === "t") {
        return node.textContent ?? "";
    }

    if (name === "br") {
        return "\n";
    }

    if (name === "tab") {
        return "\t";
    }

    let text = "";
    for (const child of getChildElements(node)) {
        text += extractNodeText(child);
    }

    return text;
}

function isTitleShape(shape: XMLNodeLike): boolean {
    const placeholder = findFirstDescendant(shape, "ph");
    const type = placeholder ? getAttribute(placeholder, "type") : null;
    return type === "title" || type === "ctrTitle";
}

function isBulletParagraph(paragraph: XMLNodeLike): boolean {
    const properties = findFirstChild(paragraph, "pPr");
    if (!properties) {
        return false;
    }

    if (getAttribute(properties, "lvl") !== null) {
        return true;
    }

    return getChildElements(properties).some((node) => {
        const name = getLocalName(node);
        return name === "buChar" || name === "buAutoNum" || name === "buBlip";
    });
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
                    case "bullet":
                        blocks.push(`- ${block.text}`);
                        break;
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

function compareSlidePaths(left: string, right: string): number {
    return getSlideIndex(left) - getSlideIndex(right) || left.localeCompare(right);
}

function getSlideIndex(path: string): number {
    const match = path.match(/slide(\d+)\.xml$/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}
