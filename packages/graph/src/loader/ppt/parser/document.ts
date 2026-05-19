import type JSZip from "jszip";
import {
    createImageIdFactory,
    getMimeTypeForPath,
    getRelationshipsForPart,
    loadOOXMLZip,
    parseContentTypes,
    readZipBinary,
    readZipText,
} from "../../ooxml/package";
import {
    childElements,
    findFirstChild,
    findFirstDescendant,
    getAttribute,
    getDocumentRoot,
    getLocalName,
    parseXml,
    squashWhitespace,
} from "../../ooxml/xml";
import type { XMLNodeLike } from "../../ooxml/types";
import type { ParsedPPT, PPTParseContext, SlideBlock, SlideContent } from "./types";

export function parsePPT(content: ArrayBuffer, ocr: boolean): Promise<ParsedPPT> {
    return parsePPTDocument(content, ocr);
}

async function parsePPTDocument(content: ArrayBuffer, ocr: boolean): Promise<ParsedPPT> {
    const zip = await loadOOXMLZip(content);
    const contentTypes = parseContentTypes(await readZipText(zip, "[Content_Types].xml"));
    const slidePaths = await getSlidePaths(zip);
    const images: ParsedPPT["images"] = [];
    const slides: SlideContent[] = [];
    const nextImageId = createImageIdFactory();
    const imageIdByTarget = new Map<string, string>();

    for (const [index, slidePath] of slidePaths.entries()) {
        const relationships = await getRelationshipsForPart(zip, slidePath);
        const slide = await parseSlide(slidePath, index, {
            zip,
            relationships,
            contentTypes,
            images,
            imageIdByTarget,
            nextImageId,
            ocr,
        });

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
        const orderedPaths: string[] = [];
        if (slideIdList) {
            for (const node of childElements(slideIdList)) {
                if (getLocalName(node) !== "sldId") {
                    continue;
                }

                const relationshipId = getAttribute(node, "r:id", "id");
                const relationship = relationshipId ? presentationRelationships.get(relationshipId) : null;
                if (relationship && !relationship.external) {
                    orderedPaths.push(relationship.target);
                }
            }
        }

        if (orderedPaths.length > 0) {
            return orderedPaths;
        }
    }

    return Object.keys(zip.files)
        .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
        .sort(compareSlidePaths);
}

async function parseSlide(slidePath: string, index: number, context: PPTParseContext): Promise<SlideContent> {
    const slideXml = await readZipText(context.zip, slidePath);
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

    for (const node of childElements(shapeTree)) {
        const name = getLocalName(node);
        if (name === "nvGrpSpPr" || name === "grpSpPr") {
            continue;
        }

        const nextBlocks = await parseSlideNode(node, context);
        for (const block of nextBlocks) {
            if (block.kind === "heading") {
                hasTitle = true;
            }

            blocks.push(block);
        }
    }

    return { index, hasTitle, blocks };
}

async function parseSlideNode(node: XMLNodeLike, context: PPTParseContext): Promise<SlideBlock[]> {
    switch (getLocalName(node)) {
        case "sp":
            return parseShape(node);
        case "pic":
            return context.ocr ? parsePicture(node, context) : [];
        case "graphicFrame":
            return parseGraphicFrame(node);
        case "grpSp": {
            const blocks: SlideBlock[] = [];
            for (const child of childElements(node)) {
                const childName = getLocalName(child);
                if (childName === "nvGrpSpPr" || childName === "grpSpPr") {
                    continue;
                }

                blocks.push(...(await parseSlideNode(child, context)));
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

    const paragraphs: Array<{ text: string; isBullet: boolean }> = [];
    for (const paragraph of childElements(textBody)) {
        if (getLocalName(paragraph) !== "p") {
            continue;
        }

        const text = squashWhitespace(extractParagraphText(paragraph).replace(/\s*\n\s*/g, " "));
        if (text.length > 0) {
            paragraphs.push({
                text,
                isBullet: isBulletParagraph(paragraph),
            });
        }
    }

    if (paragraphs.length === 0) {
        return [];
    }

    if (isTitleShape(shape)) {
        return [
            {
                kind: "heading",
                text: squashWhitespace(paragraphs.map((paragraph) => paragraph.text).join(" ")),
            },
        ];
    }

    return paragraphs.map((paragraph) => ({
        kind: paragraph.isBullet ? "bullet" : "paragraph",
        text: paragraph.text,
    }));
}

async function parsePicture(picture: XMLNodeLike, context: PPTParseContext): Promise<SlideBlock[]> {
    const blip = findFirstDescendant(picture, "blip");
    const relationshipId = blip ? getAttribute(blip, "r:embed", "embed") : null;
    if (!relationshipId) {
        return [];
    }

    const relationship = context.relationships.get(relationshipId);
    if (!relationship || relationship.external) {
        return [];
    }

    const cachedId = context.imageIdByTarget.get(relationship.target);
    if (cachedId) {
        return [{ kind: "image", id: cachedId }];
    }

    const content = await readZipBinary(context.zip, relationship.target);
    if (!content) {
        return [];
    }

    const id = context.nextImageId();
    context.images.push({
        id,
        type: getMimeTypeForPath(context.contentTypes, relationship.target),
        content,
    });
    context.imageIdByTarget.set(relationship.target, id);

    return [{ kind: "image", id }];
}

function parseGraphicFrame(frame: XMLNodeLike): SlideBlock[] {
    const table = findFirstDescendant(frame, "tbl");
    if (!table) {
        return [];
    }

    const rows: string[][] = [];
    for (const row of childElements(table)) {
        if (getLocalName(row) !== "tr") {
            continue;
        }

        const cells: string[] = [];
        for (const cell of childElements(row)) {
            if (getLocalName(cell) === "tc") {
                cells.push(extractTableCellText(cell));
            }
        }

        if (cells.length > 0) {
            rows.push(cells);
        }
    }

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

    const parts: string[] = [];
    for (const paragraph of childElements(textBody)) {
        if (getLocalName(paragraph) !== "p") {
            continue;
        }

        const text = squashWhitespace(extractParagraphText(paragraph).replace(/\s*\n\s*/g, " "));
        if (text) {
            parts.push(text);
        }
    }

    return squashWhitespace(parts.join(" "));
}

function extractParagraphText(paragraph: XMLNodeLike): string {
    return extractNodeText(paragraph);
}

function extractNodeText(node: XMLNodeLike): string {
    const parts: string[] = [];
    appendNodeText(node, parts);
    return parts.join("");
}

function appendNodeText(node: XMLNodeLike, parts: string[]): void {
    const name = getLocalName(node);
    if (name === "t") {
        parts.push(node.textContent ?? "");
        return;
    }

    if (name === "br") {
        parts.push("\n");
        return;
    }

    if (name === "tab") {
        parts.push("\t");
        return;
    }

    for (const child of childElements(node)) {
        appendNodeText(child, parts);
    }
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

    for (const node of childElements(properties)) {
        const name = getLocalName(node);
        if (name === "buChar" || name === "buAutoNum" || name === "buBlip") {
            return true;
        }
    }

    return false;
}

function compareSlidePaths(left: string, right: string): number {
    return getSlideIndex(left) - getSlideIndex(right) || left.localeCompare(right);
}

function getSlideIndex(path: string): number {
    const match = path.match(/slide(\d+)\.xml$/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
