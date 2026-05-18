import { Effect } from "effect";
import {
    createImageIdFactory,
    getMimeTypeForPath,
    getRelationshipsForPartEffect,
    loadOOXMLZipEffect,
    parseContentTypesEffect,
    readZipBinaryEffect,
    readZipTextEffect,
} from "../../ooxml/package";
import {
    findDescendants,
    findFirstChild,
    findFirstDescendant,
    getAttribute,
    getChildElements,
    getDocumentRoot,
    getLocalName,
    parseXml,
    parseXmlEffect,
} from "../../ooxml/xml";
import type { XMLNodeLike } from "../../ooxml/types";
import {
    clampHeadingLevel,
    cleanInlineText,
    detectHeadingLevel,
    formatInlineText,
    mergeInlineTextPieces,
} from "./text";
import type {
    DOCBlock,
    DOCNumbering,
    DOCParseContext,
    DOCStyles,
    InlinePiece,
    ParagraphListInfo,
    ParsedDOC,
} from "./types";

export function parseDOCX(content: ArrayBuffer, ocr: boolean): Promise<ParsedDOC> {
    return Effect.runPromise(parseDOCXEffect(content, ocr));
}

export function parseDOCXEffect(content: ArrayBuffer, ocr: boolean): Effect.Effect<ParsedDOC, unknown> {
    return Effect.gen(function* () {
        const zip = yield* loadOOXMLZipEffect(content);
        const documentXml = yield* readZipTextEffect(zip, "word/document.xml");
        if (!documentXml) {
            return { blocks: [], images: [] };
        }

        const relationships = yield* getRelationshipsForPartEffect(zip, "word/document.xml");
        const contentTypes = yield* parseContentTypesEffect(yield* readZipTextEffect(zip, "[Content_Types].xml"));
        const styles = yield* parseDOCStylesEffect(yield* readZipTextEffect(zip, "word/styles.xml"));
        const numbering = yield* parseDOCNumberingEffect(yield* readZipTextEffect(zip, "word/numbering.xml"));
        const context: DOCParseContext = {
            zip,
            relationships,
            contentTypes,
            styles,
            numbering,
            images: [],
            nextImageId: createImageIdFactory(),
            ocr,
        };

        const document = yield* parseXmlEffect(documentXml);
        const root = getDocumentRoot(document);
        const body = root ? findFirstDescendant(root, "body") : null;
        if (!body) {
            return { blocks: [], images: [] };
        }

        const blocks: DOCBlock[] = [];
        for (const node of getChildElements(body)) {
            switch (getLocalName(node)) {
                case "p":
                    blocks.push(...(yield* parseParagraphEffect(node, context)));
                    break;
                case "tbl": {
                    const table = yield* parseTableEffect(node, context);
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
    });
}

function parseParagraphEffect(paragraph: XMLNodeLike, context: DOCParseContext): Effect.Effect<DOCBlock[], unknown> {
    return Effect.gen(function* () {
        const headingLevel = getParagraphHeadingLevel(paragraph, context.styles);
        const listInfo = getParagraphListInfo(paragraph, context.numbering);
        const pieces = yield* collectParagraphPiecesEffect(paragraph, context);
        if (pieces.length === 0) {
            return [];
        }

        const blocks: DOCBlock[] = [];
        let textBuffer = "";

        const flushText = () => {
            const text = cleanInlineText(textBuffer);
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
    });
}

function parseTableEffect(table: XMLNodeLike, context: DOCParseContext): Effect.Effect<DOCBlock | null, unknown> {
    return Effect.gen(function* () {
        const rows = getChildElements(table).filter((node) => getLocalName(node) === "tr");
        const renderedRows: string[][] = [];

        for (const row of rows) {
            const cells = getChildElements(row).filter((node) => getLocalName(node) === "tc");
            if (cells.length === 0) {
                continue;
            }

            const renderedCells: string[] = [];
            for (const cell of cells) {
                renderedCells.push(yield* extractTableCellTextEffect(cell, context));
            }
            renderedRows.push(renderedCells);
        }

        const nonEmptyRows = renderedRows.filter((row) => row.some((cell) => cell.length > 0) || row.length > 0);
        return nonEmptyRows.length === 0 ? null : { kind: "table", rows: nonEmptyRows };
    });
}

function extractTableCellTextEffect(cell: XMLNodeLike, context: DOCParseContext): Effect.Effect<string, unknown> {
    return Effect.gen(function* () {
        const parts: string[] = [];
        const textOnlyContext = { ...context, ocr: false };

        for (const node of getChildElements(cell)) {
            if (getLocalName(node) !== "p") {
                continue;
            }

            const pieces = yield* collectParagraphPiecesEffect(node, textOnlyContext);
            const text = cleanInlineText(
                pieces
                    .filter((piece): piece is Extract<InlinePiece, { kind: "text" }> => piece.kind === "text")
                    .map((piece) => piece.text)
                    .join("")
            );

            if (text) {
                parts.push(text.replace(/\s*\n\s*/g, " "));
            }
        }

        return cleanInlineText(parts.join(" "));
    });
}

function collectParagraphPiecesEffect(
    paragraph: XMLNodeLike,
    context: DOCParseContext
): Effect.Effect<InlinePiece[], unknown> {
    return Effect.gen(function* () {
        const pieces: InlinePiece[] = [];

        for (const child of getChildElements(paragraph)) {
            if (getLocalName(child) === "pPr") {
                continue;
            }

            pieces.push(...(yield* parseInlineNodeEffect(child, context, null)));
        }

        return mergeInlineTextPieces(pieces);
    });
}

function parseInlineNodeEffect(
    node: XMLNodeLike,
    context: DOCParseContext,
    hyperlinkTarget: string | null
): Effect.Effect<InlinePiece[], unknown> {
    return Effect.gen(function* () {
        switch (getLocalName(node)) {
            case "r":
                return yield* parseRunEffect(node, context, hyperlinkTarget);
            case "hyperlink": {
                const relationshipId = getAttribute(node, "r:id", "id");
                const anchor = getAttribute(node, "w:anchor", "anchor");
                const relationship = relationshipId ? context.relationships.get(relationshipId) : null;
                const target = relationship?.target ?? (anchor ? `#${anchor}` : null);
                const pieces: InlinePiece[] = [];

                for (const child of getChildElements(node)) {
                    pieces.push(...(yield* parseInlineNodeEffect(child, context, target)));
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
                    pieces.push(...(yield* parseInlineNodeEffect(child, context, hyperlinkTarget)));
                }

                return mergeInlineTextPieces(pieces);
            }
            default:
                return [];
        }
    });
}

function parseRunEffect(
    run: XMLNodeLike,
    context: DOCParseContext,
    hyperlinkTarget: string | null
): Effect.Effect<InlinePiece[], unknown> {
    return Effect.gen(function* () {
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
                        pieces.push({
                            kind: "text",
                            text: formatInlineText(value, format, hyperlinkTarget, context.ocr),
                        });
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

                    const imageId = yield* extractImageIdEffect(child, context);
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
    });
}

function extractImageIdEffect(node: XMLNodeLike, context: DOCParseContext): Effect.Effect<string | null, unknown> {
    return Effect.gen(function* () {
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

        const content = yield* readZipBinaryEffect(context.zip, relationship.target);
        if (!content) {
            return null;
        }

        const id = context.nextImageId();
        context.images.push({
            id,
            type: getMimeTypeForPath(context.contentTypes, relationship.target),
            content,
        });

        return id;
    });
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

function parseDOCStylesEffect(xml: string | null): Effect.Effect<DOCStyles, unknown> {
    return Effect.try({
        try: () => parseDOCStyles(xml),
        catch: (error) => error,
    });
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

function parseDOCNumberingEffect(xml: string | null): Effect.Effect<DOCNumbering, unknown> {
    return Effect.try({
        try: () => parseDOCNumbering(xml),
        catch: (error) => error,
    });
}

function parseDOCNumbering(xml: string | null): DOCNumbering {
    const numbering: DOCNumbering = {
        numToAbstract: new Map(),
        abstractFormats: new Map(),
    };
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

function getDocumentRootFromXml(xml: string): XMLNodeLike | null {
    return getDocumentRoot(parseXml(xml));
}
