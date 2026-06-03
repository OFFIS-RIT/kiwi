import { childElements, findDescendants, findFirstChild, getAttribute, getLocalName } from "../ooxml/xml";
import type { XMLNodeLike } from "../ooxml/types";
import { clampHeadingLevel, detectHeadingLevel } from "./text";
import type { DOCNumbering, DOCStyles, ParagraphListInfo } from "./types";

export function getParagraphHeadingLevel(properties: XMLNodeLike | null, styles: DOCStyles): number | null {
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

export function getParagraphListInfo(properties: XMLNodeLike | null, numbering: DOCNumbering): ParagraphListInfo | null {
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

export function hasRunFormatting(properties: XMLNodeLike | null, name: string): boolean {
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

export function createEmptyNumbering(): DOCNumbering {
    return {
        numToAbstract: new Map(),
        abstractFormats: new Map(),
    };
}

export function parseDOCStyles(document: XMLNodeLike | null): DOCStyles {
    const styles: DOCStyles = new Map();
    if (!document) {
        return styles;
    }

    const rawStyles = new Map<string, { name: string | null; basedOn: string | null; headingLevel: number | null }>();
    for (const style of findDescendants(document, "style")) {
        const styleId = getAttribute(style, "w:styleId", "styleId");
        if (!styleId) {
            continue;
        }

        const styleType = getAttribute(style, "w:type", "type");
        if (styleType && styleType !== "paragraph") {
            continue;
        }

        const nameNode = findFirstChild(style, "name");
        const name = nameNode ? getAttribute(nameNode, "w:val", "val") : null;
        const basedOnNode = findFirstChild(style, "basedOn");
        const basedOn = basedOnNode ? getAttribute(basedOnNode, "w:val", "val") : null;
        const properties = findFirstChild(style, "pPr");
        const outlineNode = properties ? findFirstChild(properties, "outlineLvl") : null;
        const outlineValue = outlineNode ? getAttribute(outlineNode, "w:val", "val") : null;
        const headingLevel =
            outlineValue !== null && Number.isFinite(Number(outlineValue))
                ? clampHeadingLevel(Number(outlineValue) + 1)
                : detectHeadingLevel(name ?? styleId);

        rawStyles.set(styleId, { name, basedOn, headingLevel });
    }

    const resolvedLevels = new Map<string, number | null>();
    const resolveHeadingLevel = (styleId: string, visited: Set<string> = new Set()): number | null => {
        if (resolvedLevels.has(styleId)) {
            return resolvedLevels.get(styleId) ?? null;
        }

        const style = rawStyles.get(styleId);
        if (!style) {
            return null;
        }

        if (style.headingLevel !== null) {
            resolvedLevels.set(styleId, style.headingLevel);
            return style.headingLevel;
        }

        if (visited.has(styleId)) {
            return null;
        }

        visited.add(styleId);
        const inherited = style.basedOn ? resolveHeadingLevel(style.basedOn, visited) : null;
        visited.delete(styleId);
        resolvedLevels.set(styleId, inherited);
        return inherited;
    };

    for (const [styleId, style] of rawStyles) {
        styles.set(styleId, {
            name: style.name,
            headingLevel: resolveHeadingLevel(styleId),
        });
    }

    return styles;
}

export function parseDOCNumbering(root: XMLNodeLike | null): DOCNumbering {
    const numbering = createEmptyNumbering();
    if (!root) {
        return numbering;
    }

    for (const abstractNum of findDescendants(root, "abstractNum")) {
        const abstractId = getAttribute(abstractNum, "w:abstractNumId", "abstractNumId");
        if (!abstractId) {
            continue;
        }

        const levels = new Map<number, string>();
        for (const level of childElements(abstractNum)) {
            if (getLocalName(level) !== "lvl") {
                continue;
            }

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
