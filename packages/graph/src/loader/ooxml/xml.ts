import { DOMParser } from "@xmldom/xmldom";
import { Effect } from "effect";
import type { XMLDocumentLike, XMLNodeLike } from "./types";

const XML_MIME_TYPE = "application/xml";
const XML_ERROR_HANDLER = () => undefined;

export function parseXml(xml: string): XMLDocumentLike {
    return new DOMParser({ errorHandler: XML_ERROR_HANDLER }).parseFromString(
        xml,
        XML_MIME_TYPE
    ) as unknown as XMLDocumentLike;
}

export function parseXmlEffect(xml: string): Effect.Effect<XMLDocumentLike, unknown> {
    return Effect.try({
        try: () => parseXml(xml),
        catch: (error) => error,
    });
}

export function getDocumentRoot(document: XMLDocumentLike): XMLNodeLike | null {
    return isElementNode(document.documentElement) ? document.documentElement : null;
}

export function findFirstChild(node: XMLNodeLike, name: string): XMLNodeLike | null {
    return getChildElements(node).find((child) => getLocalName(child) === name) ?? null;
}

export function findFirstDescendant(node: XMLNodeLike, name: string): XMLNodeLike | null {
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

export function findDescendants(node: XMLNodeLike, name: string): XMLNodeLike[] {
    const matches: XMLNodeLike[] = [];
    for (const child of getChildElements(node)) {
        if (getLocalName(child) === name) {
            matches.push(child);
        }

        matches.push(...findDescendants(child, name));
    }

    return matches;
}

export function getChildElements(node: XMLNodeLike): XMLNodeLike[] {
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
