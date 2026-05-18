import { Effect } from "effect";
import type JSZip from "jszip";
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
    findFirstChild,
    findFirstDescendant,
    getAttribute,
    getChildElements,
    getDocumentRoot,
    getLocalName,
    parseXmlEffect,
    squashWhitespace,
} from "../../ooxml/xml";
import type { XMLNodeLike } from "../../ooxml/types";
import type { ParsedPPT, PPTParseContext, SlideBlock, SlideContent } from "./types";

export function parsePPT(content: ArrayBuffer, ocr: boolean): Promise<ParsedPPT> {
    return Effect.runPromise(parsePPTEffect(content, ocr));
}

export function parsePPTEffect(content: ArrayBuffer, ocr: boolean): Effect.Effect<ParsedPPT, unknown> {
    return Effect.gen(function* () {
        const zip = yield* loadOOXMLZipEffect(content);
        const contentTypes = yield* parseContentTypesEffect(yield* readZipTextEffect(zip, "[Content_Types].xml"));
        const slidePaths = yield* getSlidePathsEffect(zip);
        const images: ParsedPPT["images"] = [];
        const slides: SlideContent[] = [];
        const nextImageId = createImageIdFactory();

        for (const [index, slidePath] of slidePaths.entries()) {
            const relationships = yield* getRelationshipsForPartEffect(zip, slidePath);
            const slide = yield* parseSlideEffect(slidePath, index, {
                zip,
                relationships,
                contentTypes,
                images,
                nextImageId,
                ocr,
            });

            if (slide.blocks.length > 0) {
                slides.push(slide);
            }
        }

        return { slides, images };
    });
}

function getSlidePathsEffect(zip: JSZip): Effect.Effect<string[], unknown> {
    return Effect.gen(function* () {
        const presentationXml = yield* readZipTextEffect(zip, "ppt/presentation.xml");
        const presentationRelationships = yield* getRelationshipsForPartEffect(zip, "ppt/presentation.xml");
        if (presentationXml) {
            const document = yield* parseXmlEffect(presentationXml);
            const root = getDocumentRoot(document);
            const slideIdList = root ? findFirstChild(root, "sldIdLst") : null;
            const orderedPaths = slideIdList
                ? getChildElements(slideIdList)
                      .filter((node) => getLocalName(node) === "sldId")
                      .map((node) => getAttribute(node, "r:id", "id"))
                      .map((relationshipId) => {
                          const relationship = relationshipId ? presentationRelationships.get(relationshipId) : null;
                          return relationship && !relationship.external ? relationship.target : null;
                      })
                      .filter((path): path is string => typeof path === "string")
                : [];

            if (orderedPaths.length > 0) {
                return orderedPaths;
            }
        }

        return Object.keys(zip.files)
            .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
            .sort(compareSlidePaths);
    });
}

function parseSlideEffect(
    slidePath: string,
    index: number,
    context: PPTParseContext
): Effect.Effect<SlideContent, unknown> {
    return Effect.gen(function* () {
        const slideXml = yield* readZipTextEffect(context.zip, slidePath);
        if (!slideXml) {
            return { index, hasTitle: false, blocks: [] };
        }

        const document = yield* parseXmlEffect(slideXml);
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

            const nextBlocks = yield* parseSlideNodeEffect(node, context);
            for (const block of nextBlocks) {
                if (block.kind === "heading") {
                    hasTitle = true;
                }

                blocks.push(block);
            }
        }

        return { index, hasTitle, blocks };
    });
}

function parseSlideNodeEffect(node: XMLNodeLike, context: PPTParseContext): Effect.Effect<SlideBlock[], unknown> {
    return Effect.gen(function* () {
        switch (getLocalName(node)) {
            case "sp":
                return parseShape(node);
            case "pic":
                return context.ocr ? yield* parsePictureEffect(node, context) : [];
            case "graphicFrame":
                return parseGraphicFrame(node);
            case "grpSp": {
                const blocks: SlideBlock[] = [];
                for (const child of getChildElements(node)) {
                    const childName = getLocalName(child);
                    if (childName === "nvGrpSpPr" || childName === "grpSpPr") {
                        continue;
                    }

                    blocks.push(...(yield* parseSlideNodeEffect(child, context)));
                }

                return blocks;
            }
            default:
                return [];
        }
    });
}

function parseShape(shape: XMLNodeLike): SlideBlock[] {
    const textBody = findFirstDescendant(shape, "txBody");
    if (!textBody) {
        return [];
    }

    const paragraphs = getChildElements(textBody)
        .filter((node) => getLocalName(node) === "p")
        .map((paragraph) => ({
            text: squashWhitespace(extractParagraphText(paragraph).replace(/\s*\n\s*/g, " ")),
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
                text: squashWhitespace(paragraphs.map((paragraph) => paragraph.text).join(" ")),
            },
        ];
    }

    return paragraphs.map((paragraph) => ({
        kind: paragraph.isBullet ? "bullet" : "paragraph",
        text: paragraph.text,
    }));
}

function parsePictureEffect(picture: XMLNodeLike, context: PPTParseContext): Effect.Effect<SlideBlock[], unknown> {
    return Effect.gen(function* () {
        const blip = findFirstDescendant(picture, "blip");
        const relationshipId = blip ? getAttribute(blip, "r:embed", "embed") : null;
        if (!relationshipId) {
            return [];
        }

        const relationship = context.relationships.get(relationshipId);
        if (!relationship || relationship.external) {
            return [];
        }

        const content = yield* readZipBinaryEffect(context.zip, relationship.target);
        if (!content) {
            return [];
        }

        const id = context.nextImageId();
        context.images.push({
            id,
            type: getMimeTypeForPath(context.contentTypes, relationship.target),
            content,
        });

        return [{ kind: "image", id }];
    });
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
        .map((paragraph) => squashWhitespace(extractParagraphText(paragraph).replace(/\s*\n\s*/g, " ")))
        .filter(Boolean);

    return squashWhitespace(parts.join(" "));
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

function compareSlidePaths(left: string, right: string): number {
    return getSlideIndex(left) - getSlideIndex(right) || left.localeCompare(right);
}

function getSlideIndex(path: string): number {
    const match = path.match(/slide(\d+)\.xml$/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
