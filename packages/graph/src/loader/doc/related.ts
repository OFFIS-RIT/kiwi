import {
    getMimeTypeForPath,
    getRelationshipsForPart,
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
    findDescendants,
    findFirstChild,
    findFirstDescendant,
    getAttribute,
    getDocumentRoot,
    getLocalName,
    parseXml,
} from "../ooxml/xml";
import type { XMLNodeLike } from "../ooxml/types";
import { blocksToPlainText, textToParagraphBlocks } from "./blocks";
import { cleanInlineText } from "./text";
import type { DOCBlock, DOCParseContext } from "./types";

type DOCBlockContainerParser = (container: XMLNodeLike, context: DOCParseContext) => Promise<DOCBlock[]>;

export function createDOCRelatedPartParser(parseBlockContainer: DOCBlockContainerParser) {
    async function parseReferencedTextPart(
        context: DOCParseContext,
        relationshipType: string,
        elementName: string,
        idAttributeName: string
    ): Promise<Map<string, string>> {
        const relationship = findRelationshipByType(context.relationships, relationshipType);
        if (!relationship || relationship.external) {
            return new Map();
        }

        const xml = await readZipText(context.zip, relationship.target);
        if (!xml) {
            return new Map();
        }

        const root = getDocumentRootFromXml(xml);
        if (!root) {
            return new Map();
        }

        const partRelationships = await getPartRelationships(context, relationship.target);
        const partContext = createPartContext(context, relationship.target, partRelationships);
        const entries = new Map<string, string>();

        for (const element of findDescendants(root, elementName)) {
            const id = getAttribute(element, `w:${idAttributeName}`, idAttributeName);
            const type = getAttribute(element, "w:type", "type");
            if (!id || id.startsWith("-") || (type !== null && type !== "normal")) {
                continue;
            }

            const text = blocksToPlainText(await parseBlockContainer(element, partContext));
            if (text) {
                entries.set(id, text);
            }
        }

        return entries;
    }

    async function parseDocumentLikePart(partPath: string, context: DOCParseContext): Promise<DOCBlock[]> {
        const xml = await readZipText(context.zip, partPath);
        if (!xml) {
            return [];
        }

        return parseDocumentLikeXml(xml, partPath, context);
    }

    async function parseDocumentLikeXml(xml: string, partPath: string, context: DOCParseContext): Promise<DOCBlock[]> {
        const root = getDocumentRootFromXml(xml);
        if (!root) {
            return [];
        }

        const relationships = await getPartRelationships(context, partPath);
        const partContext = createPartContext(context, partPath, relationships);
        const container = getDocumentLikeBlockContainer(root);
        return container ? parseBlockContainer(container, partContext) : [];
    }

    async function parseAltChunk(node: XMLNodeLike, context: DOCParseContext): Promise<DOCBlock[]> {
        const relationshipId = getAttribute(node, "r:id", "id");
        const relationship = relationshipId ? context.relationships.get(relationshipId) : null;
        if (!relationship || relationship.external) {
            return [];
        }

        const contentType = getMimeTypeForPath(context.contentTypes, relationship.target).toLowerCase();
        if (isEmbeddedOfficeDocumentType(contentType, relationship.target)) {
            const content = await readZipBinary(context.zip, relationship.target);
            return content
                ? textToParagraphBlocks(
                      await readEmbeddedPackageText(toArrayBuffer(content), relationship.target, contentType, context)
                  )
                : [];
        }

        const content = await readZipText(context.zip, relationship.target);
        if (!content) {
            return [];
        }

        return parseChunkTextContent(content, contentType, relationship.target, context);
    }

    async function extractRelatedTextFromNode(node: XMLNodeLike, context: DOCParseContext): Promise<string> {
        if (context.depth >= 2) {
            return "";
        }

        return extractRelatedPartTextFromNode({
            node,
            relationships: context.relationships,
            readPartText: (partPath) => readRelatedPartText(partPath, context),
            formatText: (parts) => cleanInlineText(parts.join("\n")),
        });
    }

    async function extractTextBoxText(node: XMLNodeLike, context: DOCParseContext): Promise<string> {
        const textOnlyContext = { ...context, ocr: false };
        const blocks: DOCBlock[] = [];

        for (const textBox of findDescendants(node, "txbxContent")) {
            blocks.push(...(await parseBlockContainer(textBox, textOnlyContext)));
        }

        return blocksToPlainText(blocks);
    }

    async function readRelatedPartText(partPath: string, context: DOCParseContext): Promise<string> {
        if (context.seenPartPaths.has(partPath)) {
            return "";
        }

        const contentType = getMimeTypeForPath(context.contentTypes, partPath).toLowerCase();
        if (isEmbeddedOfficeDocumentType(contentType, partPath)) {
            const binary = await readZipBinary(context.zip, partPath);
            if (!binary) {
                return "";
            }

            return readEmbeddedPackageText(toArrayBuffer(binary), partPath, contentType, context);
        }

        const xml = await readZipText(context.zip, partPath);
        if (!xml) {
            return "";
        }

        if (contentType.includes("html") || looksLikeHTML(xml)) {
            return htmlToText(xml);
        }

        if (contentType.includes("rtf") || looksLikeRTF(xml)) {
            return rtfToText(xml);
        }

        if (contentType.includes("message/rfc822") || contentType.includes("mhtml") || looksLikeMHT(xml)) {
            return mhtToText(xml);
        }

        const blocks = await parseDocumentLikeXml(xml, partPath, {
            ...context,
            depth: context.depth + 1,
            seenPartPaths: new Set([...context.seenPartPaths, partPath]),
        });
        if (blocks.length > 0) {
            return blocksToPlainText(blocks);
        }

        return cleanInlineText(getDocumentRootFromXml(xml)?.textContent ?? "");
    }

    async function readEmbeddedPackageText(
        content: ArrayBuffer,
        partPath: string,
        contentType: string,
        context: DOCParseContext
    ): Promise<string> {
        return extractEmbeddedOfficeDocumentText({
            content,
            partPath,
            contentType,
            depth: context.depth,
            markdown: context.markdown,
            readers: {
                docx: async (embeddedContent, options) => {
                    const { parseDOCX } = await import("./document");
                    const parsed = await parseDOCX(embeddedContent, {
                        ocr: false,
                        markdown: options.markdown ?? true,
                        depth: options.depth,
                    });
                    return blocksToPlainText(parsed.blocks);
                },
                pptx: async (embeddedContent, options) => {
                    const { parsePPT } = await import("../ppt/document");
                    const { slideBlocksToPlainText } = await import("../ppt/blocks");
                    const parsed = await parsePPT(embeddedContent, {
                        ocr: false,
                        markdown: options.markdown ?? true,
                        depth: options.depth,
                    });
                    return cleanInlineText(parsed.slides.map((slide) => slideBlocksToPlainText(slide.blocks)).join("\n"));
                },
                xlsx: async (embeddedContent, options) =>
                    (await import("../excel/document")).extractExcel(embeddedContent, { depth: options.depth }).then(
                        (result) => result.text
                    ),
            },
        });
    }

    function parseChunkTextContent(
        content: string,
        contentType: string,
        partPath: string,
        context: DOCParseContext
    ): Promise<DOCBlock[]> {
        if (contentType.includes("html") || looksLikeHTML(content)) {
            return Promise.resolve(textToParagraphBlocks(htmlToText(content)));
        }

        if (contentType.includes("rtf") || looksLikeRTF(content)) {
            return Promise.resolve(textToParagraphBlocks(rtfToText(content)));
        }

        if (contentType.includes("message/rfc822") || contentType.includes("mhtml") || looksLikeMHT(content)) {
            return Promise.resolve(textToParagraphBlocks(mhtToText(content)));
        }

        if (contentType.includes("xml") || looksLikeXML(content)) {
            return parseDocumentLikeXml(content, partPath, context).then((blocks) => {
                if (blocks.length > 0) {
                    return blocks;
                }

                const xmlRoot = getDocumentRootFromXml(content);
                return textToParagraphBlocks(xmlRoot?.textContent ?? "");
            });
        }

        return Promise.resolve(textToParagraphBlocks(content));
    }

    return {
        parseReferencedTextPart,
        parseDocumentLikePart,
        parseDocumentLikeXml,
        parseAltChunk,
        extractRelatedTextFromNode,
        extractTextBoxText,
        getPartRelationships,
    };
}

function looksLikeHTML(value: string): boolean {
    return /<!doctype\s+html|<html\b|<body\b|<p\b|<div\b/i.test(value);
}

function looksLikeXML(value: string): boolean {
    return /^\s*</.test(value);
}

function looksLikeRTF(value: string): boolean {
    return /^\s*{\\rtf/i.test(value);
}

function looksLikeMHT(value: string): boolean {
    return /^\s*(?:mime-version:|content-type:\s*multipart\/)/im.test(value);
}

function htmlToText(value: string): string {
    return cleanInlineText(
        decodeHtmlEntities(
            value
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
                .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
                .replace(/<!--[\s\S]*?-->/g, " ")
                .replace(/<\s*br\s*\/?>/gi, "\n")
                .replace(/<\s*\/\s*(p|div|section|article|li|tr|h[1-6])\s*>/gi, "\n")
                .replace(/<\s*li\b[^>]*>/gi, "- ")
                .replace(/<[^>]+>/g, " ")
        )
    );
}

function decodeHtmlEntities(value: string): string {
    return value.replace(/&(?:#([0-9]+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]+));/g, (match, decimal, hex, named) => {
        if (decimal) {
            return decodeNumericCharacter(Number(decimal));
        }

        if (hex) {
            return decodeNumericCharacter(Number.parseInt(hex, 16));
        }

        switch (named.toLowerCase()) {
            case "amp":
                return "&";
            case "lt":
                return "<";
            case "gt":
                return ">";
            case "quot":
                return '"';
            case "apos":
                return "'";
            case "nbsp":
                return " ";
            default:
                return match;
        }
    });
}

function rtfToText(value: string): string {
    return cleanInlineText(
        decodeHtmlEntities(
            value
                .replace(/\\par[d]?/gi, "\n")
                .replace(/\\line/gi, "\n")
                .replace(/\\tab/gi, "\t")
                .replace(/\\'[0-9a-fA-F]{2}/g, (match) => String.fromCharCode(Number.parseInt(match.slice(2), 16)))
                .replace(/\\u(-?\d+)\??/g, (_match, code) => decodeNumericCharacter(Number(code) < 0 ? Number(code) + 65536 : Number(code)))
                .replace(/\\[a-z]+-?\d* ?/gi, " ")
                .replace(/[{}]/g, " ")
        )
    );
}

function mhtToText(value: string): string {
    const htmlPartMatch = value.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*)/i);
    if (htmlPartMatch?.[1]) {
        return htmlToText(htmlPartMatch[1]);
    }

    return cleanInlineText(
        value
            .replace(/^Content-[^\n]*$/gim, " ")
            .replace(/^MIME-Version:[^\n]*$/gim, " ")
            .replace(/^--[^\n]*$/gim, " ")
    );
}

function getDocumentRootFromXml(xml: string): XMLNodeLike | null {
    return getDocumentRoot(parseXml(xml));
}

function getDocumentLikeBlockContainer(root: XMLNodeLike): XMLNodeLike | null {
    const name = getLocalName(root);
    switch (name) {
        case "body":
        case "hdr":
        case "ftr":
        case "footnote":
        case "endnote":
        case "comment":
            return root;
        default:
            return findFirstChild(root, "body") ?? findFirstDescendant(root, "body");
    }
}

function createPartContext(
    context: DOCParseContext,
    partPath: string,
    relationships: DOCParseContext["relationships"]
): DOCParseContext {
    return {
        ...context,
        partPath,
        relationships,
        seenPartPaths: new Set([...context.seenPartPaths, partPath]),
    };
}

async function getPartRelationships(context: DOCParseContext, partPath: string) {
    return getPartRelationshipsFromCache({
        partPath,
        cache: context.relationshipsByPart,
        loadRelationships: (nextPartPath) => getRelationshipsForPart(context.zip, nextPartPath),
    });
}

function decodeNumericCharacter(codePoint: number): string {
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        return "";
    }

    try {
        return String.fromCodePoint(codePoint);
    } catch {
        return "";
    }
}
