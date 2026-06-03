import { DOMParser } from "@xmldom/xmldom";
import type { XMLDocumentLike, XMLNodeLike } from "./types";

const XML_MIME_TYPE = "application/xml";
const XML_ERROR_HANDLER = () => undefined;

export function parseXml(xml: string): XMLDocumentLike {
    try {
        const document = new DOMParser({ errorHandler: XML_ERROR_HANDLER }).parseFromString(
            xml,
            XML_MIME_TYPE
        ) as unknown as XMLDocumentLike;
        const root = getDocumentRoot(document);
        if (root && getLocalName(root) !== "parsererror") {
            return document;
        }
    } catch {
        // Fall through to the lenient parser below.
    }

    return parseXmlLenient(xml);
}

export function getDocumentRoot(document: XMLDocumentLike): XMLNodeLike | null {
    return isElementNode(document.documentElement) ? document.documentElement : null;
}

export function findFirstChild(node: XMLNodeLike, name: string): XMLNodeLike | null {
    for (const child of childElements(node)) {
        if (getLocalName(child) === name) {
            return child;
        }
    }

    return null;
}

export function findFirstDescendant(node: XMLNodeLike, name: string): XMLNodeLike | null {
    for (const child of childElements(node)) {
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

export function findDescendants(node: XMLNodeLike, name: string): XMLNodeLike[] {
    const matches: XMLNodeLike[] = [];
    for (const child of childElements(node)) {
        if (getLocalName(child) === name) {
            matches.push(child);
        }

        matches.push(...findDescendants(child, name));
    }

    return matches;
}

export function getChildElements(node: XMLNodeLike): XMLNodeLike[] {
    return Array.from(childElements(node));
}

export function* childElements(node: XMLNodeLike): IterableIterator<XMLNodeLike> {
    const childNodes = node.childNodes;
    if (!childNodes) {
        return;
    }

    for (let index = 0; index < childNodes.length; index += 1) {
        const child = childNodes[index];
        if (isElementNode(child)) {
            yield child;
        }
    }
}

export function isElementNode(value: unknown): value is XMLNodeLike {
    return typeof value === "object" && value !== null && (value as XMLNodeLike).nodeType === 1;
}

export function getLocalName(node: XMLNodeLike): string {
    const localName = node.localName;
    if (typeof localName === "string" && localName.length > 0) {
        return localName;
    }

    const nodeName = node.nodeName ?? "";
    const colonIndex = nodeName.indexOf(":");
    return colonIndex >= 0 ? nodeName.slice(colonIndex + 1) : nodeName;
}

export function getAttribute(node: XMLNodeLike, ...names: string[]): string | null {
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

export function squashWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

type LenientXMLNode = LenientXMLElement | LenientXMLTextNode;

type LenientXMLElement = XMLNodeLike & {
    nodeType: 1;
    nodeName: string;
    localName: string;
    textContent: string;
    childNodes: LenientXMLNode[];
    getAttribute: (name: string) => string | null;
};

type LenientXMLTextNode = {
    nodeType: 3;
    nodeName: "#text";
    localName: "#text";
    textContent: string;
    childNodes: [];
};

function parseXmlLenient(xml: string): XMLDocumentLike {
    const syntheticRoot = createLenientElement("#document", new Map());
    const stack: LenientXMLElement[] = [syntheticRoot];
    let documentElement: LenientXMLElement | null = null;
    let index = 0;

    while (index < xml.length) {
        const tagStart = xml.indexOf("<", index);
        if (tagStart < 0) {
            appendLenientText(stack[stack.length - 1] ?? syntheticRoot, xml.slice(index));
            break;
        }

        if (tagStart > index) {
            appendLenientText(stack[stack.length - 1] ?? syntheticRoot, xml.slice(index, tagStart));
        }

        if (xml.startsWith("<!--", tagStart)) {
            const commentEnd = xml.indexOf("-->", tagStart + 4);
            index = commentEnd >= 0 ? commentEnd + 3 : xml.length;
            continue;
        }

        if (xml.startsWith("<![CDATA[", tagStart)) {
            const cdataEnd = xml.indexOf("]]>", tagStart + 9);
            const cdata = cdataEnd >= 0 ? xml.slice(tagStart + 9, cdataEnd) : xml.slice(tagStart + 9);
            appendLenientText(stack[stack.length - 1] ?? syntheticRoot, cdata);
            index = cdataEnd >= 0 ? cdataEnd + 3 : xml.length;
            continue;
        }

        if (xml.startsWith("<?", tagStart)) {
            const declarationEnd = xml.indexOf("?>", tagStart + 2);
            index = declarationEnd >= 0 ? declarationEnd + 2 : xml.length;
            continue;
        }

        const tagEnd = findTagEnd(xml, tagStart + 1);
        if (tagEnd < 0) {
            appendLenientText(stack[stack.length - 1] ?? syntheticRoot, xml.slice(tagStart));
            break;
        }

        const rawTag = xml.slice(tagStart + 1, tagEnd).trim();
        index = tagEnd + 1;

        if (!rawTag || rawTag.startsWith("!")) {
            continue;
        }

        if (rawTag.startsWith("/")) {
            closeLenientElement(stack, rawTag.slice(1).trim());
            continue;
        }

        const selfClosing = rawTag.endsWith("/");
        const normalizedTag = selfClosing ? rawTag.slice(0, -1).trimEnd() : rawTag;
        const nameMatch = normalizedTag.match(/^([^\s/>]+)/);
        if (!nameMatch) {
            continue;
        }

        const nodeName = nameMatch[1] ?? "";
        const attributes = parseLenientAttributes(normalizedTag.slice(nodeName.length));
        const element = createLenientElement(nodeName, attributes);
        const parent = stack[stack.length - 1] ?? syntheticRoot;
        parent.childNodes.push(element);

        if (!documentElement && nodeName !== "#document") {
            documentElement = element;
        }

        if (!selfClosing) {
            stack.push(element);
        }
    }

    if (documentElement) {
        populateLenientTextContent(documentElement);
    }

    return { documentElement };
}

function findTagEnd(xml: string, start: number): number {
    let quote: '"' | "'" | null = null;
    for (let index = start; index < xml.length; index += 1) {
        const char = xml[index];
        if (quote) {
            if (char === quote) {
                quote = null;
            }

            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (char === ">") {
            return index;
        }
    }

    return -1;
}

function closeLenientElement(stack: LenientXMLElement[], nodeName: string): void {
    if (stack.length <= 1 || !nodeName) {
        return;
    }

    for (let index = stack.length - 1; index >= 1; index -= 1) {
        if (stack[index]?.nodeName === nodeName) {
            stack.length = index;
            return;
        }
    }
}

function parseLenientAttributes(source: string): Map<string, string> {
    const attributes = new Map<string, string>();
    let index = 0;

    while (index < source.length) {
        while (index < source.length && /\s/u.test(source[index] ?? "")) {
            index += 1;
        }

        if (index >= source.length) {
            break;
        }

        const nameStart = index;
        while (index < source.length && !/[\s=]/u.test(source[index] ?? "")) {
            index += 1;
        }

        const name = source.slice(nameStart, index).trim();
        if (!name) {
            break;
        }

        while (index < source.length && /\s/u.test(source[index] ?? "")) {
            index += 1;
        }

        if (source[index] !== "=") {
            attributes.set(name, "");
            continue;
        }

        index += 1;
        while (index < source.length && /\s/u.test(source[index] ?? "")) {
            index += 1;
        }

        const quote = source[index];
        if (quote === '"' || quote === "'") {
            index += 1;
            const valueStart = index;
            while (index < source.length && source[index] !== quote) {
                index += 1;
            }

            attributes.set(name, decodeXMLValue(source.slice(valueStart, index)));
            if (source[index] === quote) {
                index += 1;
            }
            continue;
        }

        const valueStart = index;
        while (index < source.length && !/\s/u.test(source[index] ?? "")) {
            index += 1;
        }

        attributes.set(name, decodeXMLValue(source.slice(valueStart, index)));
    }

    return attributes;
}

function createLenientElement(nodeName: string, attributes: Map<string, string>): LenientXMLElement {
    return {
        nodeType: 1,
        nodeName,
        localName: getLenientLocalName(nodeName),
        textContent: "",
        childNodes: [],
        getAttribute: (name: string) => attributes.get(name) ?? null,
    };
}

function appendLenientText(parent: LenientXMLElement, value: string): void {
    if (!value) {
        return;
    }

    parent.childNodes.push({
        nodeType: 3,
        nodeName: "#text",
        localName: "#text",
        textContent: decodeXMLValue(value),
        childNodes: [],
    });
}

function populateLenientTextContent(node: LenientXMLElement): string {
    let text = "";
    for (const child of node.childNodes) {
        if ((child as LenientXMLElement).nodeType === 1) {
            text += populateLenientTextContent(child as LenientXMLElement);
            continue;
        }

        text += child.textContent ?? "";
    }

    node.textContent = text;
    return text;
}

function getLenientLocalName(nodeName: string): string {
    const colonIndex = nodeName.indexOf(":");
    return colonIndex >= 0 ? nodeName.slice(colonIndex + 1) : nodeName;
}

function decodeXMLValue(value: string): string {
    return value.replace(/&(?:#([0-9]+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]+));/g, (match, decimal, hex, named) => {
        if (decimal) {
            return decodeNumericXMLCharacter(Number(decimal));
        }

        if (hex) {
            return decodeNumericXMLCharacter(Number.parseInt(hex, 16));
        }

        switch (named) {
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
            default:
                return match;
        }
    });
}

function decodeNumericXMLCharacter(codePoint: number): string {
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        return "";
    }

    try {
        return String.fromCodePoint(codePoint);
    } catch {
        return "";
    }
}
