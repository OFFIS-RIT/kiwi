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
    findFirstChild,
    findFirstDescendant,
    getAttribute,
    getDocumentRoot,
    getLocalName,
    parseXml,
} from "../ooxml/xml";
import type { XMLNodeLike } from "../ooxml/types";
import { clampHeadingLevel, cleanInlineText, detectHeadingLevel, formatInlineText } from "./text";
import { blocksToPlainText, looksLikeHeaderRow } from "./blocks";
import {
    createFieldAwareSink,
    decodeRunSymbol,
    getFieldSimpleHyperlinkTarget,
    getPreferredAlternateContentBranch,
    PLAIN_INLINE_FORMAT,
    renderReferenceText,
    type InlineSink,
} from "./field";
import { createDOCRelatedPartParser } from "./related";
import {
    createEmptyNumbering,
    getParagraphHeadingLevel,
    getParagraphListInfo,
    hasRunFormatting,
    parseDOCNumbering,
    parseDOCStyles,
} from "./styles";
import type {
    DOCBlock,
    DOCNumbering,
    DOCParseContext,
    DOCParseOptions,
    DOCStyles,
    ParagraphListInfo,
    ParsedDOC,
} from "./types";

const RELATIONSHIP_TYPE_HEADER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
const RELATIONSHIP_TYPE_FOOTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";
const RELATIONSHIP_TYPE_FOOTNOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes";
const RELATIONSHIP_TYPE_ENDNOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes";
const RELATIONSHIP_TYPE_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";

type SectionRelationshipRefs = {
    headers: Map<string, string>;
    footers: Map<string, string>;
};

type DocumentSection = {
    nodes: XMLNodeLike[];
    sectPr: XMLNodeLike | null;
};

const { parseReferencedTextPart, parseDocumentLikePart, parseAltChunk, extractRelatedTextFromNode, extractTextBoxText } =
    createDOCRelatedPartParser(parseBlockContainer);

export function parseDOCX(content: ArrayBuffer, options: boolean | DOCParseOptions): Promise<ParsedDOC> {
    return parseDOCXDocument(content, normalizeDOCParseOptions(options));
}

async function parseDOCXDocument(content: ArrayBuffer, options: DOCParseOptions): Promise<ParsedDOC> {
    const zip = await loadOOXMLZip(content);
    const documentXml = await readZipText(zip, "word/document.xml");
    if (!documentXml) {
        return { blocks: [], images: [] };
    }

    const relationships = await getRelationshipsForPart(zip, "word/document.xml");
    const contentTypes = parseContentTypes(await readZipText(zip, "[Content_Types].xml"));
    const styles: DOCStyles = hasWordElement(documentXml, "pStyle")
        ? parseDOCStyles(getDocumentRootFromXml(await readZipText(zip, "word/styles.xml")))
        : new Map();
    const numbering = hasWordElement(documentXml, "numPr")
        ? parseDOCNumbering(getDocumentRootFromXml(await readZipText(zip, "word/numbering.xml")))
        : createEmptyNumbering();
    const context: DOCParseContext = {
        zip,
        partPath: "word/document.xml",
        relationships,
        relationshipsByPart: new Map([["word/document.xml", relationships]]),
        contentTypes,
        styles,
        numbering,
        referenceTexts: {
            footnotes: new Map(),
            endnotes: new Map(),
            comments: new Map(),
        },
        images: [],
        imageIdByTarget: new Map(),
        nextImageId: createImageIdFactory(),
        ocr: options.ocr,
        markdown: options.markdown ?? true,
        depth: options.depth ?? 0,
        seenPartPaths: new Set(["word/document.xml"]),
    };

    const document = parseXml(documentXml);
    const root = getDocumentRoot(document);
    const body = root ? (findFirstChild(root, "body") ?? findFirstDescendant(root, "body")) : null;
    if (!body) {
        return { blocks: [], images: [] };
    }

    context.referenceTexts.footnotes = await parseReferencedTextPart(
        context,
        RELATIONSHIP_TYPE_FOOTNOTES,
        "footnote",
        "id"
    );
    context.referenceTexts.endnotes = await parseReferencedTextPart(
        context,
        RELATIONSHIP_TYPE_ENDNOTES,
        "endnote",
        "id"
    );
    context.referenceTexts.comments = await parseReferencedTextPart(
        context,
        RELATIONSHIP_TYPE_COMMENTS,
        "comment",
        "id"
    );

    const blocks = await parseDocumentSections(body, context);

    return {
        blocks,
        images: context.images,
    };
}

function normalizeDOCParseOptions(options: boolean | DOCParseOptions): DOCParseOptions {
    return typeof options === "boolean" ? { ocr: options, markdown: true, depth: 0 } : options;
}

async function parseDocumentSections(body: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock[]> {
    const sections = splitDocumentSections(body);
    const blocks: DOCBlock[] = [];
    let inheritedRefs: SectionRelationshipRefs = { headers: new Map(), footers: new Map() };

    for (const section of sections) {
        const sectionRefs = resolveSectionRelationshipRefs(section.sectPr, context, inheritedRefs);
        blocks.push(...(await parseSectionPartBlocks(sectionRefs.headers, context, RELATIONSHIP_TYPE_HEADER)));
        blocks.push(...(await parseBlockNodes(section.nodes, context)));
        blocks.push(...(await parseSectionPartBlocks(sectionRefs.footers, context, RELATIONSHIP_TYPE_FOOTER)));
        inheritedRefs = sectionRefs;
    }

    if (blocks.length === 0) {
        return parseBlockContainer(body, context);
    }

    return blocks;
}

function splitDocumentSections(body: XMLNodeLike): DocumentSection[] {
    const sections: DocumentSection[] = [];
    let nodes: XMLNodeLike[] = [];

    const flush = (sectPr: XMLNodeLike | null) => {
        if (nodes.length > 0 || sectPr) {
            sections.push({ nodes, sectPr });
            nodes = [];
        }
    };

    for (const child of childElements(body)) {
        const name = getLocalName(child);
        if (name === "sectPr") {
            flush(child);
            continue;
        }

        nodes.push(child);
        if (name === "p") {
            const paragraphProperties = findFirstChild(child, "pPr");
            const sectPr = paragraphProperties ? findFirstChild(paragraphProperties, "sectPr") : null;
            if (sectPr) {
                flush(sectPr);
            }
        }
    }

    flush(null);
    return sections.length > 0 ? sections : [{ nodes: Array.from(childElements(body)), sectPr: null }];
}

function resolveSectionRelationshipRefs(
    sectPr: XMLNodeLike | null,
    context: DOCParseContext,
    inherited: SectionRelationshipRefs
): SectionRelationshipRefs {
    const headers = new Map(inherited.headers);
    const footers = new Map(inherited.footers);

    if (sectPr) {
        for (const child of childElements(sectPr)) {
            const name = getLocalName(child);
            if (name !== "headerReference" && name !== "footerReference") {
                continue;
            }

            const relationshipId = getAttribute(child, "r:id", "id");
            const relationship = relationshipId ? context.relationships.get(relationshipId) : null;
            if (!relationship || relationship.external) {
                continue;
            }

            const referenceType = (getAttribute(child, "w:type", "type") ?? "default").toLowerCase();
            if (name === "headerReference") {
                headers.set(referenceType, relationship.target);
                continue;
            }

            footers.set(referenceType, relationship.target);
        }
    }

    if (headers.size === 0 && footers.size === 0) {
        for (const relationship of context.relationships.values()) {
            if (relationship.external) {
                continue;
            }

            if (relationship.type === RELATIONSHIP_TYPE_HEADER) {
                headers.set(`fallback:${headers.size}`, relationship.target);
                continue;
            }

            if (relationship.type === RELATIONSHIP_TYPE_FOOTER) {
                footers.set(`fallback:${footers.size}`, relationship.target);
            }
        }
    }

    return { headers, footers };
}

async function parseSectionPartBlocks(
    references: Map<string, string>,
    context: DOCParseContext,
    relationshipType: string
): Promise<DOCBlock[]> {
    const blocks: DOCBlock[] = [];
    const seen = new Set<string>();
    for (const partPath of references.values()) {
        if (seen.has(partPath)) {
            continue;
        }

        seen.add(partPath);
        blocks.push(...(await parseDocumentLikePart(partPath, context)));
    }

    if (blocks.length > 0) {
        return blocks;
    }

    for (const relationship of context.relationships.values()) {
        if (relationship.external || relationship.type !== relationshipType || seen.has(relationship.target)) {
            continue;
        }

        seen.add(relationship.target);
        blocks.push(...(await parseDocumentLikePart(relationship.target, context)));
    }

    return blocks;
}

async function parseBlockNodes(nodes: XMLNodeLike[], context: DOCParseContext): Promise<DOCBlock[]> {
    const blocks: DOCBlock[] = [];
    for (const node of nodes) {
        blocks.push(...(await parseBlockNode(node, context)));
    }

    return blocks;
}

async function parseBlockContainer(container: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock[]> {
    const blocks: DOCBlock[] = [];
    for (const child of childElements(container)) {
        blocks.push(...(await parseBlockNode(child, context)));
    }

    return blocks;
}

async function parseBlockNode(node: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock[]> {
    switch (getLocalName(node)) {
        case "p":
            return parseParagraph(node, context);
        case "tbl": {
            const table = await parseTable(node, context);
            return table ? [table] : [];
        }
        case "altChunk":
            return parseAltChunk(node, context);
        case "smartTag":
        case "sdt":
        case "sdtContent":
        case "ins":
        case "moveTo":
        case "customXml":
        case "Choice":
        case "Fallback":
            return parseBlockContainer(node, context);
        case "del":
        case "moveFrom":
            return [];
        case "AlternateContent": {
            const branch = getPreferredAlternateContentBranch(node);
            return branch ? parseBlockContainer(branch, context) : [];
        }
        default:
            return [];
    }
}

async function parseParagraph(paragraph: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock[]> {
    const properties = findFirstChild(paragraph, "pPr");
    const headingLevel = getParagraphHeadingLevel(properties, context.styles);
    const listInfo = getParagraphListInfo(properties, context.numbering);
    const blocks: DOCBlock[] = [];
    let textParts: string[] = [];
    let canSkipInitialRenderedPageBreak = hasPageBreakBefore(properties);

    if (canSkipInitialRenderedPageBreak) {
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
        onText: (text) => {
            canSkipInitialRenderedPageBreak = false;
            textParts.push(text);
        },
        onImage: (id) => {
            canSkipInitialRenderedPageBreak = false;
            flushText();
            blocks.push({ kind: "image", id });
        },
        onPageBreak: (source) => {
            if (source === "rendered" && canSkipInitialRenderedPageBreak) {
                canSkipInitialRenderedPageBreak = false;
                return;
            }

            canSkipInitialRenderedPageBreak = false;
            flushText();
            blocks.push({ kind: "pageBreak" });
        },
    });

    flushText();
    return blocks;
}

async function parseTable(table: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock | null> {
    const renderedRows: string[][] = [];
    let hasHeader = false;

    for (const row of childElements(table)) {
        if (getLocalName(row) !== "tr") {
            continue;
        }

        if (isHeaderTableRow(row)) {
            hasHeader = true;
        }

        const renderedCells: string[] = [];
        for (const cell of childElements(row)) {
            if (getLocalName(cell) !== "tc") {
                continue;
            }

            const text = await extractTableCellText(cell, context);
            const gridSpan = Math.max(1, getTableCellGridSpan(cell));
            const vMerge = getTableCellVerticalMergeState(cell);
            renderedCells.push(vMerge === "continue" ? "" : text);
            for (let spanIndex = 1; spanIndex < gridSpan; spanIndex += 1) {
                renderedCells.push("");
            }
        }

        if (renderedCells.length > 0) {
            renderedRows.push(renderedCells);
        }
    }

    return renderedRows.length === 0 ? null : { kind: "table", rows: renderedRows, hasHeader: hasHeader || looksLikeHeaderRow(renderedRows) };
}

async function extractTableCellText(cell: XMLNodeLike, context: DOCParseContext): Promise<string> {
    const textOnlyContext = { ...context, ocr: false };
    const blocks = await parseBlockContainer(cell, textOnlyContext);
    return blocksToPlainText(blocks).replace(/\s*\n\s*/g, " ");
}

function isHeaderTableRow(row: XMLNodeLike): boolean {
    const properties = findFirstChild(row, "trPr");
    return properties ? findFirstChild(properties, "tblHeader") !== null : false;
}

function getTableCellGridSpan(cell: XMLNodeLike): number {
    const properties = findFirstChild(cell, "tcPr");
    const gridSpan = properties ? findFirstChild(properties, "gridSpan") : null;
    const value = gridSpan ? getAttribute(gridSpan, "w:val", "val") : null;
    return Number.isFinite(Number(value)) ? Number(value) : 1;
}

function getTableCellVerticalMergeState(cell: XMLNodeLike): "restart" | "continue" | null {
    const properties = findFirstChild(cell, "tcPr");
    const merge = properties ? findFirstChild(properties, "vMerge") : null;
    if (!merge) {
        return null;
    }

    const value = (getAttribute(merge, "w:val", "val") ?? "continue").toLowerCase();
    return value === "restart" ? "restart" : "continue";
}

async function collectParagraphContent(
    paragraph: XMLNodeLike,
    context: DOCParseContext,
    sink: InlineSink
): Promise<void> {
    const fieldAware = createFieldAwareSink(sink, context.markdown);

    for (const child of childElements(paragraph)) {
        if (getLocalName(child) === "pPr") {
            continue;
        }

        await parseInlineNode(child, context, null, fieldAware.sink);
    }

    fieldAware.flush();
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
        case "AlternateContent": {
            const branch = getPreferredAlternateContentBranch(node);
            if (!branch) {
                return;
            }

            for (const child of childElements(branch)) {
                await parseInlineNode(child, context, hyperlinkTarget, sink);
            }

            return;
        }
        case "hyperlink": {
            let target: string | null = null;
            if (context.markdown) {
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
        case "moveTo":
        case "customXml":
        case "Choice":
        case "Fallback": {
            for (const child of childElements(node)) {
                await parseInlineNode(child, context, hyperlinkTarget, sink);
            }

            return;
        }
        case "del":
        case "moveFrom":
            return;
        case "fldSimple": {
            const target = context.markdown ? (getFieldSimpleHyperlinkTarget(node) ?? hyperlinkTarget) : null;
            for (const child of childElements(node)) {
                await parseInlineNode(child, context, target, sink);
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
    const format = context.markdown ? getRunFormat(run) : PLAIN_INLINE_FORMAT;

    for (const child of childElements(run)) {
        switch (getLocalName(child)) {
            case "rPr":
                break;
            case "t": {
                const value = child.textContent ?? "";
                if (value) {
                    sink.onText(formatInlineText(value, format, context.markdown ? hyperlinkTarget : null, context.markdown));
                }
                break;
            }
            case "delText":
                break;
            case "instrText": {
                const value = child.textContent ?? "";
                if (value) {
                    sink.onInstructionText?.(value);
                }
                break;
            }
            case "fldChar": {
                const fieldType = getAttribute(child, "w:fldCharType", "fldCharType");
                switch (fieldType) {
                    case "begin":
                        sink.onFieldStart?.();
                        break;
                    case "separate":
                        sink.onFieldSeparator?.();
                        break;
                    case "end":
                        sink.onFieldEnd?.();
                        break;
                    default:
                        break;
                }
                break;
            }
            case "br":
                if (getAttribute(child, "w:type", "type") === "page") {
                    sink.onPageBreak("explicit");
                    break;
                }

                sink.onText("\n");
                break;
            case "lastRenderedPageBreak":
                sink.onPageBreak("rendered");
                break;
            case "cr":
                sink.onText("\n");
                break;
            case "tab":
                sink.onText("\t");
                break;
            case "sym": {
                const symbol = decodeRunSymbol(child);
                if (symbol) {
                    sink.onText(symbol);
                }
                break;
            }
            case "footnoteReference": {
                const id = getAttribute(child, "w:id", "id");
                const text = id ? context.referenceTexts.footnotes.get(id) : null;
                if (text) {
                    sink.onText(renderReferenceText("Footnote", text));
                }
                break;
            }
            case "endnoteReference": {
                const id = getAttribute(child, "w:id", "id");
                const text = id ? context.referenceTexts.endnotes.get(id) : null;
                if (text) {
                    sink.onText(renderReferenceText("Endnote", text));
                }
                break;
            }
            case "commentReference": {
                const id = getAttribute(child, "w:id", "id");
                const text = id ? context.referenceTexts.comments.get(id) : null;
                if (text) {
                    sink.onText(renderReferenceText("Comment", text));
                }
                break;
            }
            case "footnoteRef":
            case "endnoteRef":
            case "annotationRef":
                break;
            case "noBreakHyphen":
            case "softHyphen":
                sink.onText("-");
                break;
            case "drawing":
            case "pict": {
                const textBoxText = await extractTextBoxText(child, context);
                if (textBoxText) {
                    sink.onText(textBoxText);
                }

                const relatedText = await extractRelatedTextFromNode(child, context);
                if (relatedText) {
                    sink.onText(relatedText);
                }

                if (!context.ocr) {
                    break;
                }

                const imageId = await extractImageId(child, context);
                if (imageId) {
                    sink.onImage(imageId);
                }
                break;
            }
            case "object": {
                const relatedText = await extractRelatedTextFromNode(child, context);
                if (relatedText) {
                    sink.onText(relatedText);
                }
                break;
            }
            case "oMath":
            case "oMathPara": {
                const text = cleanInlineText(child.textContent ?? "");
                if (text) {
                    sink.onText(text);
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

function getDocumentRootFromXml(xml: string | null): XMLNodeLike | null {
    return xml ? getDocumentRoot(parseXml(xml)) : null;
}
