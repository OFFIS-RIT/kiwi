import type JSZip from "jszip";
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
    extractEmbeddedOfficeDocumentText,
    isEmbeddedOfficeDocumentType,
    toArrayBuffer,
} from "../ooxml/embedded";
import {
    extractRelatedPartTextFromNode,
    findRelationshipByType,
    getPartRelationshipsFromCache,
} from "../ooxml/related";
import {
    childElements,
    findDescendants,
    findFirstChild,
    findFirstDescendant,
    getAttribute,
    getDocumentRoot,
    getLocalName,
    parseXml,
    squashWhitespace,
} from "../ooxml/xml";
import type { XMLNodeLike } from "../ooxml/types";
import type { DOCBlock } from "../doc/types";
import { slideBlocksToPlainText } from "./blocks";
import type { ParsedPPT, PPTParseContext, PPTParseOptions, SlideBlock, SlideContent } from "./types";

const RELATIONSHIP_TYPE_NOTES_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const RELATIONSHIP_TYPE_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const RELATIONSHIP_TYPE_COMMENT_AUTHORS =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors";
const RELATIONSHIP_TYPE_SLIDE_LAYOUT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const RELATIONSHIP_TYPE_SLIDE_MASTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const NOTE_PLACEHOLDER_TYPES = new Set(["title", "ctrTitle", "subTitle", "hdr", "ftr", "dt", "sldNum", "sldImg"]);
const TEMPLATE_PLACEHOLDER_TYPES = new Set(["hdr", "ftr", "dt", "sldNum"]);

type SlideParseMode = "slide" | "notes" | "template";

export function parsePPT(content: ArrayBuffer, options: boolean | PPTParseOptions): Promise<ParsedPPT> {
    return parsePPTDocument(content, normalizePPTParseOptions(options));
}

async function parsePPTDocument(content: ArrayBuffer, options: PPTParseOptions): Promise<ParsedPPT> {
    const zip = await loadOOXMLZip(content);
    const contentTypes = parseContentTypes(await readZipText(zip, "[Content_Types].xml"));
    const presentationRelationships = await getRelationshipsForPart(zip, "ppt/presentation.xml");
    const slidePaths = await getSlidePaths(zip);
    const images: ParsedPPT["images"] = [];
    const slides: SlideContent[] = [];
    const nextImageId = createImageIdFactory();
    const imageIdByTarget = new Map<string, string>();
    const relationshipsByPart = new Map<string, PPTParseContext["relationships"]>([
        ["ppt/presentation.xml", presentationRelationships],
    ]);
    const baseContext: PPTParseContext = {
        zip,
        presentationRelationships,
        relationships: presentationRelationships,
        relationshipsByPart,
        commentAuthorsById: null,
        contentTypes,
        images,
        imageIdByTarget,
        nextImageId,
        ocr: options.ocr,
        markdown: options.markdown ?? true,
        depth: options.depth ?? 0,
    };

    for (const [index, slidePath] of slidePaths.entries()) {
        const relationships = await getPartRelationships(baseContext, slidePath);
        const slideContext: PPTParseContext = {
            ...baseContext,
            relationships,
        };
        const slide = await parseSlide(slidePath, index, slideContext);
        if (slideContext.commentAuthorsById) {
            baseContext.commentAuthorsById = slideContext.commentAuthorsById;
        }

        if (slide.blocks.length > 0) {
            slides.push(slide);
        }
    }

    return { slides, images };
}

function normalizePPTParseOptions(options: boolean | PPTParseOptions): PPTParseOptions {
    return typeof options === "boolean" ? { ocr: options, markdown: true, depth: 0 } : options;
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

    const blocks = await parseSlideContainer(shapeTree, context, "slide");
    blocks.push(...(await parseInheritedSlideBlocks(slidePath, context, blocks)));
    const notes = await parseNotesText(context);
    if (notes) {
        blocks.push({ kind: "paragraph", text: notes });
    }
    blocks.push(...(await parseCommentBlocks(context)));

    const hasTitle = blocks.some((block) => block.kind === "heading");
    return { index, hasTitle, blocks };
}

async function parseSlideContainer(
    container: XMLNodeLike,
    context: PPTParseContext,
    mode: SlideParseMode
): Promise<SlideBlock[]> {
    const blocks: SlideBlock[] = [];
    for (const child of childElements(container)) {
        const childName = getLocalName(child);
        if (childName === "nvGrpSpPr" || childName === "grpSpPr") {
            continue;
        }

        blocks.push(...(await parseSlideNode(child, context, mode)));
    }

    return blocks;
}

async function parseSlideNode(node: XMLNodeLike, context: PPTParseContext, mode: SlideParseMode): Promise<SlideBlock[]> {
    switch (getLocalName(node)) {
        case "sp":
            return parseShape(node, context, mode);
        case "pic":
            return context.ocr && mode === "slide" ? parsePicture(node, context) : [];
        case "graphicFrame":
            return parseGraphicFrame(node, context);
        case "contentPart":
        case "oleObj":
            return parseRelatedTextBlock(node, context);
        case "grpSp":
        case "spTree":
        case "cSld":
        case "Choice":
        case "Fallback":
            return parseSlideContainer(node, context, mode);
        case "AlternateContent": {
            const branch = getPreferredAlternateContentBranch(node);
            return branch ? parseSlideContainer(branch, context, mode) : [];
        }
        default:
            return [];
    }
}

function parseShape(shape: XMLNodeLike, context: PPTParseContext, mode: SlideParseMode): SlideBlock[] {
    const placeholderType = getShapePlaceholderType(shape);
    if (mode === "notes" && placeholderType && NOTE_PLACEHOLDER_TYPES.has(placeholderType)) {
        return [];
    }

    if (mode === "template" && placeholderType && !TEMPLATE_PLACEHOLDER_TYPES.has(placeholderType)) {
        return [];
    }

    const textBody = findFirstDescendant(shape, "txBody");
    if (!textBody) {
        return [];
    }

    const paragraphs: Array<{ text: string; isBullet: boolean; level: number; ordered: boolean }> = [];
    for (const paragraph of childElements(textBody)) {
        if (getLocalName(paragraph) !== "p") {
            continue;
        }

        const text = squashWhitespace(extractParagraphText(paragraph, context).replace(/\s*\n\s*/g, " "));
        if (text.length > 0) {
            const bulletInfo = getBulletInfo(paragraph);
            paragraphs.push({
                text,
                isBullet: bulletInfo !== null,
                level: bulletInfo?.level ?? 0,
                ordered: bulletInfo?.ordered ?? false,
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

    return paragraphs.map<SlideBlock>((paragraph) =>
        paragraph.isBullet
            ? { kind: "bullet", text: paragraph.text, level: paragraph.level, ordered: paragraph.ordered }
            : { kind: "paragraph", text: paragraph.text }
    );
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

async function parseGraphicFrame(frame: XMLNodeLike, context: PPTParseContext): Promise<SlideBlock[]> {
    const table = findFirstDescendant(frame, "tbl");
    if (!table) {
        return parseRelatedTextBlock(frame, context);
    }

    const rows: string[][] = [];
    const hasHeader = getAttribute(findFirstDescendant(table, "tblPr") ?? table, "firstRow") === "1";
    for (const row of childElements(table)) {
        if (getLocalName(row) !== "tr") {
            continue;
        }

        const cells: string[] = [];
        for (const cell of childElements(row)) {
            if (getLocalName(cell) === "tc") {
                const hMerge = getAttribute(cell, "hMerge") === "1";
                const vMerge = getAttribute(cell, "vMerge") === "1";
                const gridSpan = Math.max(1, Number(getAttribute(cell, "gridSpan") ?? "1") || 1);
                cells.push(hMerge || vMerge ? "" : extractTableCellText(cell, context));
                for (let spanIndex = 1; spanIndex < gridSpan; spanIndex += 1) {
                    cells.push("");
                }
            }
        }

        if (cells.length > 0) {
            rows.push(cells);
        }
    }

    if (rows.length === 0) {
        return [];
    }

    return [{ kind: "table", rows, hasHeader: hasHeader || looksLikeHeaderRow(rows) }];
}

function extractTableCellText(cell: XMLNodeLike, context: PPTParseContext): string {
    const textBody = findFirstDescendant(cell, "txBody");
    if (!textBody) {
        return "";
    }

    const parts: string[] = [];
    for (const paragraph of childElements(textBody)) {
        if (getLocalName(paragraph) !== "p") {
            continue;
        }

        const text = squashWhitespace(extractParagraphText(paragraph, context).replace(/\s*\n\s*/g, " "));
        if (text) {
            parts.push(text);
        }
    }

    return squashWhitespace(parts.join(" "));
}

function extractParagraphText(paragraph: XMLNodeLike, context: PPTParseContext): string {
    const parts: string[] = [];
    for (const child of childElements(paragraph)) {
        appendParagraphNodeText(child, parts, context);
    }

    return parts.join("");
}

function extractNodeText(node: XMLNodeLike): string {
    const parts: string[] = [];
    appendNodeText(node, parts);
    return parts.join("");
}

function appendParagraphNodeText(node: XMLNodeLike, parts: string[], context: PPTParseContext): void {
    const name = getLocalName(node);
    if (name === "AlternateContent") {
        const branch = getPreferredAlternateContentBranch(node);
        if (branch) {
            appendParagraphNodeText(branch, parts, context);
        }

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

    if (name === "r") {
        parts.push(extractRunText(node, context));
        return;
    }

    if (name === "fld") {
        parts.push(extractFieldText(node, context));
        return;
    }

    for (const child of childElements(node)) {
        appendParagraphNodeText(child, parts, context);
    }
}

function appendNodeText(node: XMLNodeLike, parts: string[]): void {
    const name = getLocalName(node);
    if (name === "AlternateContent") {
        const branch = getPreferredAlternateContentBranch(node);
        if (branch) {
            appendNodeText(branch, parts);
        }

        return;
    }

    if (name === "t" || name === "text") {
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
    const type = getShapePlaceholderType(shape);
    return type === "title" || type === "ctrTitle";
}

function getBulletInfo(paragraph: XMLNodeLike): { level: number; ordered: boolean } | null {
    const properties = findFirstChild(paragraph, "pPr");
    if (!properties) {
        return null;
    }

    const level = Math.max(0, Number(getAttribute(properties, "lvl") ?? "0") || 0);
    for (const node of childElements(properties)) {
        const name = getLocalName(node);
        if (name === "buAutoNum") {
            return { level, ordered: true };
        }

        if (name === "buChar" || name === "buBlip") {
            return { level, ordered: false };
        }
    }

    return getAttribute(properties, "lvl") !== null ? { level, ordered: false } : null;
}

function extractRunText(run: XMLNodeLike, context: PPTParseContext): string {
    const text = squashWhitespace(extractNodeText(run).replace(/\s*\n\s*/g, " "));
    if (!text) {
        return "";
    }

    if (!context.markdown) {
        return text;
    }

    const runProperties = findFirstChild(run, "rPr");
    const hyperlink = runProperties ? resolveHyperlinkTarget(runProperties, context) : null;
    return hyperlink ? `[${text}](${hyperlink})` : text;
}

function extractFieldText(field: XMLNodeLike, context: PPTParseContext): string {
    const text = squashWhitespace(extractNodeText(field).replace(/\s*\n\s*/g, " "));
    if (!text) {
        return "";
    }

    if (!context.markdown) {
        return text;
    }

    const target = resolveHyperlinkTarget(field, context);
    return target ? `[${text}](${target})` : text;
}

function resolveHyperlinkTarget(node: XMLNodeLike, context: PPTParseContext): string | null {
    const hyperlink = findFirstChild(node, "hlinkClick") ?? findFirstDescendant(node, "hlinkClick");
    if (!hyperlink) {
        return null;
    }

    const action = getAttribute(hyperlink, "action");
    const relationshipId = getAttribute(hyperlink, "r:id", "id");
    if (relationshipId) {
        const relationship = context.relationships.get(relationshipId);
        if (relationship?.target) {
            return relationship.target;
        }
    }

    if (action?.startsWith("ppaction://hlinksldjump")) {
        const jumpRelationshipId = getAttribute(hyperlink, "id");
        const relationship = jumpRelationshipId ? context.relationships.get(jumpRelationshipId) : null;
        return relationship?.target ?? null;
    }

    return null;
}

function looksLikeHeaderRow(rows: string[][]): boolean {
    if (rows.length < 2) {
        return false;
    }

    const firstRow = rows[0] ?? [];
    const secondRow = rows[1] ?? [];
    if (firstRow.length === 0 || firstRow.some((cell) => cell.length === 0)) {
        return false;
    }

    return secondRow.some((cell) => /^[-+]?\d+(?:[.,]\d+)?$/.test(cell) || cell.length === 0);
}

function compareSlidePaths(left: string, right: string): number {
    return getSlideIndex(left) - getSlideIndex(right) || left.localeCompare(right);
}

function getSlideIndex(path: string): number {
    const match = path.match(/slide(\d+)\.xml$/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function parseInheritedSlideBlocks(
    slidePath: string,
    context: PPTParseContext,
    existingBlocks: SlideBlock[]
): Promise<SlideBlock[]> {
    const layout = await parseRelatedSlideContainerBlocks(
        slidePath,
        context,
        RELATIONSHIP_TYPE_SLIDE_LAYOUT,
        "template"
    );
    const master = await parseRelatedSlideContainerBlocks(
        await getRelatedPartPath(slidePath, context, RELATIONSHIP_TYPE_SLIDE_LAYOUT),
        context,
        RELATIONSHIP_TYPE_SLIDE_MASTER,
        "template"
    );

    const seenTexts = new Set(existingBlocks.map((block) => normalizeBlockText(block)).filter(Boolean));
    return [...layout, ...master].filter((block) => {
        const key = normalizeBlockText(block);
        if (!key || seenTexts.has(key)) {
            return false;
        }

        seenTexts.add(key);
        return true;
    });
}

async function parseRelatedSlideContainerBlocks(
    partPath: string | null,
    context: PPTParseContext,
    relationshipType: string,
    mode: SlideParseMode
): Promise<SlideBlock[]> {
    if (!partPath) {
        return [];
    }

    const relationships = await getPartRelationships(context, partPath);
    const relationship = findRelationshipByType(relationships, relationshipType);
    if (!relationship || relationship.external) {
        return [];
    }

    const xml = await readZipText(context.zip, relationship.target);
    if (!xml) {
        return [];
    }

    const root = getDocumentRoot(parseXml(xml));
    const shapeTree = root ? findFirstDescendant(root, "spTree") : null;
    if (!shapeTree) {
        return [];
    }

    return parseSlideContainer(shapeTree, { ...context, relationships, depth: context.depth + 1 }, mode);
}

async function getRelatedPartPath(
    partPath: string | null,
    context: PPTParseContext,
    relationshipType: string
): Promise<string | null> {
    if (!partPath) {
        return null;
    }

    const relationships = await getPartRelationships(context, partPath);
    const relationship = findRelationshipByType(relationships, relationshipType);
    return relationship && !relationship.external ? relationship.target : null;
}

function normalizeBlockText(block: SlideBlock): string {
    switch (block.kind) {
        case "heading":
        case "paragraph":
        case "bullet":
            return squashWhitespace(block.text);
        case "table":
            return squashWhitespace(block.rows.map((row) => row.join(" ")).join(" "));
        case "image":
            return "";
    }
}

async function parseRelatedTextBlock(node: XMLNodeLike, context: PPTParseContext): Promise<SlideBlock[]> {
    const text = await extractRelatedTextFromNode(node, context);
    return text ? [{ kind: "paragraph", text }] : [];
}

async function parseNotesText(context: PPTParseContext): Promise<string | null> {
    const relationship = findRelationshipByType(context.relationships, RELATIONSHIP_TYPE_NOTES_SLIDE);
    if (!relationship || relationship.external) {
        return null;
    }

    const notesXml = await readZipText(context.zip, relationship.target);
    if (!notesXml) {
        return null;
    }

    const document = parseXml(notesXml);
    const root = getDocumentRoot(document);
    const shapeTree = root ? findFirstDescendant(root, "spTree") : null;
    if (!shapeTree) {
        return null;
    }

    const relationships = await getPartRelationships(context, relationship.target);
    const noteBlocks = await parseSlideContainer(shapeTree, { ...context, relationships }, "notes");
    const noteText = slideBlocksToPlainText(noteBlocks);
    return noteText ? `[Notes: ${noteText}]` : null;
}

async function parseCommentBlocks(context: PPTParseContext): Promise<SlideBlock[]> {
    const relationship = findRelationshipByType(context.relationships, RELATIONSHIP_TYPE_COMMENTS);
    if (!relationship || relationship.external) {
        return [];
    }

    const commentsXml = await readZipText(context.zip, relationship.target);
    if (!commentsXml) {
        return [];
    }

    const authorNames = await getCommentAuthorNames(context);
    const root = getDocumentRoot(parseXml(commentsXml));
    if (!root) {
        return [];
    }

    const blocks: SlideBlock[] = [];
    for (const comment of findDescendants(root, "cm")) {
        const text = squashWhitespace(extractNodeText(comment).replace(/\s*\n\s*/g, " "));
        if (!text) {
            continue;
        }

        const authorId = getAttribute(comment, "authorId");
        const author = authorId ? authorNames.get(authorId) : null;
        const label = author ? `Comment by ${author}` : "Comment";
        blocks.push({ kind: "paragraph", text: `[${label}: ${text}]` });
    }

    return blocks;
}

async function getCommentAuthorNames(context: PPTParseContext): Promise<Map<string, string>> {
    if (context.commentAuthorsById) {
        return context.commentAuthorsById;
    }

    const relationship = findRelationshipByType(context.presentationRelationships, RELATIONSHIP_TYPE_COMMENT_AUTHORS);
    if (!relationship || relationship.external) {
        context.commentAuthorsById = new Map();
        return context.commentAuthorsById;
    }

    const xml = await readZipText(context.zip, relationship.target);
    if (!xml) {
        context.commentAuthorsById = new Map();
        return context.commentAuthorsById;
    }

    const root = getDocumentRoot(parseXml(xml));
    const authors = new Map<string, string>();
    if (root) {
        for (const author of findDescendants(root, "cmAuthor")) {
            const id = getAttribute(author, "id");
            const name = getAttribute(author, "name") ?? getAttribute(author, "initials");
            if (id && name) {
                authors.set(id, name);
            }
        }
    }

    context.commentAuthorsById = authors;
    return authors;
}

async function extractRelatedTextFromNode(node: XMLNodeLike, context: PPTParseContext): Promise<string> {
    if (context.depth >= 2) {
        return "";
    }

    return extractRelatedPartTextFromNode({
        node,
        relationships: context.relationships,
        readPartText: (partPath) => readRelatedPartText(partPath, context),
        formatText: (parts) => squashWhitespace(parts.join(" ")),
    });
}

async function readRelatedPartText(partPath: string, context: PPTParseContext): Promise<string> {
    const contentType = getMimeTypeForPath(context.contentTypes, partPath).toLowerCase();
    if (isEmbeddedOfficeDocumentType(contentType, partPath)) {
        const binary = await readZipBinary(context.zip, partPath);
        if (!binary) {
            return "";
        }

        return extractEmbeddedPackageText(toArrayBuffer(binary), partPath, context);
    }

    const xml = await readZipText(context.zip, partPath);
    if (!xml) {
        return "";
    }

    const root = getDocumentRoot(parseXml(xml));
    if (!root) {
        return "";
    }

    const shapeTree = findFirstDescendant(root, "spTree");
    if (shapeTree) {
        const relationships = await getPartRelationships(context, partPath);
        const blocks = await parseSlideContainer(shapeTree, { ...context, relationships, depth: context.depth + 1 }, "template");
        const plain = slideBlocksToPlainText(blocks);
        if (plain) {
            return plain;
        }
    }

    return squashWhitespace(root.textContent?.replace(/\s*\n\s*/g, " ") ?? "");
}

async function extractEmbeddedPackageText(
    content: ArrayBuffer,
    partPath: string,
    context: PPTParseContext
): Promise<string> {
    const contentType = getMimeTypeForPath(context.contentTypes, partPath).toLowerCase();
    return extractEmbeddedOfficeDocumentText({
        content,
        partPath,
        contentType,
        depth: context.depth,
        markdown: context.markdown,
        readers: {
            docx: async (embeddedContent, options) => {
                const { parseDOCX } = await import("../doc/document");
                const parsed = await parseDOCX(embeddedContent, {
                    ocr: false,
                    markdown: options.markdown ?? true,
                    depth: options.depth,
                });
                return squashWhitespace(parsed.blocks.flatMap((block) => blocksFromDocBlock(block)).join(" "));
            },
            pptx: async (embeddedContent, options) => {
                const parsed = await parsePPT(embeddedContent, {
                    ocr: false,
                    markdown: options.markdown ?? true,
                    depth: options.depth,
                });
                return squashWhitespace(parsed.slides.map((slide) => slideBlocksToPlainText(slide.blocks)).join(" "));
            },
            xlsx: async (embeddedContent, options) =>
                (await import("../excel/document")).extractExcel(embeddedContent, { depth: options.depth }).then(
                    (result) => result.text
                ),
        },
    });
}

async function getPartRelationships(context: PPTParseContext, partPath: string) {
    return getPartRelationshipsFromCache({
        partPath,
        cache: context.relationshipsByPart,
        loadRelationships: (nextPartPath) => getRelationshipsForPart(context.zip, nextPartPath),
    });
}

function getPreferredAlternateContentBranch(node: XMLNodeLike): XMLNodeLike | null {
    let fallback: XMLNodeLike | null = null;
    for (const child of childElements(node)) {
        const name = getLocalName(child);
        if (name === "Choice") {
            return child;
        }

        if (name === "Fallback" && !fallback) {
            fallback = child;
        }
    }

    return fallback;
}

function getShapePlaceholderType(shape: XMLNodeLike): string | null {
    const placeholder = findFirstDescendant(shape, "ph");
    return placeholder ? getAttribute(placeholder, "type") : null;
}

function blocksFromDocBlock(block: DOCBlock): string[] {
    switch (block.kind) {
        case "heading":
        case "paragraph":
        case "bullet":
            return [block.text];
        case "table":
            return block.rows.map((row) => row.join(" "));
        case "image":
        case "pageBreak":
            return [];
    }
}
