import { DOMParser } from "@xmldom/xmldom";
import type { GraphLoader } from "../types";

type XMLSection = {
    path: string;
    depth: number;
    attributes: Array<{ name: string; value: string }>;
    lines: string[];
};

type XMLAttributeLike = {
    name?: string | null;
    value?: string | null;
};

type XMLNodeLike = {
    nodeType?: number;
    nodeName?: string | null;
    textContent?: string | null;
    childNodes?: ArrayLike<unknown>;
    attributes?: ArrayLike<XMLAttributeLike>;
};

const XML_MIME_TYPE = "application/xml";
const XML_ERROR_HANDLER = () => undefined;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;

export class XMLLoader implements GraphLoader {
    constructor(private readonly options: { loader: GraphLoader }) {}

    async getText(): Promise<string> {
        return xmlToStructuredText(await this.options.loader.getText());
    }
}

export function xmlToStructuredText(input: string): string {
    return tryXMLToStructuredText(input) ?? input.trim();
}

export function tryXMLToStructuredText(input: string): string | null {
    const text = input.trim();
    if (text === "") {
        return "";
    }

    const root = parseXMLRoot(text);
    if (!root) {
        return null;
    }

    const sections = renderElementSections(root, `/${nodeName(root)}`, 1);
    const rendered = ["# XML Document", ...sections.map(renderSection)].join("\n\n").trim();
    return rendered || null;
}

function parseXMLRoot(input: string): XMLNodeLike | null {
    try {
        const document = new DOMParser({ errorHandler: XML_ERROR_HANDLER }).parseFromString(
            input,
            XML_MIME_TYPE
        ) as unknown as { documentElement?: XMLNodeLike };
        const root = document.documentElement;
        if (!root || !isElementNode(root) || localName(root) === "parsererror") {
            return null;
        }

        return root;
    } catch {
        return null;
    }
}

function renderElementSections(element: XMLNodeLike, path: string, depth: number): XMLSection[] {
    const sections: XMLSection[] = [
        {
            path,
            depth,
            attributes: readAttributes(element),
            lines: directContentLines(element),
        },
    ];

    for (const child of childElementsWithPaths(element, path)) {
        sections.push(...renderElementSections(child.node, child.path, depth + 1));
    }

    return sections;
}

function renderSection(section: XMLSection): string {
    const headingLevel = Math.min(section.depth + 1, 6);
    const lines = [`${"#".repeat(headingLevel)} ${section.path}`];

    if (section.attributes.length > 0) {
        lines.push("", "Attributes:");
        for (const attribute of section.attributes) {
            lines.push(`- ${attribute.name}: ${attribute.value}`);
        }
    }

    if (section.lines.length > 0) {
        lines.push("", ...section.lines);
    }

    return lines.join("\n").trim();
}

function childElementsWithPaths(element: XMLNodeLike, parentPath: string): Array<{ node: XMLNodeLike; path: string }> {
    const counts = new Map<string, number>();
    const children = childNodes(element).filter(isElementNode);

    return children.map((child) => {
        const name = nodeName(child);
        const index = (counts.get(name) ?? 0) + 1;
        counts.set(name, index);
        return {
            node: child,
            path: `${parentPath}/${name}[${index}]`,
        };
    });
}

function directContentLines(element: XMLNodeLike): string[] {
    const lines: string[] = [];

    for (const child of childNodes(element)) {
        if (isElementNode(child) || child.nodeType === PROCESSING_INSTRUCTION_NODE) {
            continue;
        }

        if (child.nodeType === TEXT_NODE) {
            const value = collapseWhitespace(child.textContent ?? "");
            if (value) {
                lines.push(value);
            }
            continue;
        }

        if (child.nodeType === COMMENT_NODE) {
            const comment = (child.textContent ?? "").trim();
            if (comment) {
                lines.push(`Comment: ${comment}`);
            }
            continue;
        }

        if (child.nodeType === CDATA_SECTION_NODE) {
            const cdata = (child.textContent ?? "").trim();
            if (cdata) {
                lines.push(`CDATA: ${cdata}`);
            }
        }
    }

    return lines;
}

function childNodes(node: XMLNodeLike): XMLNodeLike[] {
    return Array.from(node.childNodes ?? []).filter(isXMLNodeLike);
}

function readAttributes(element: XMLNodeLike): Array<{ name: string; value: string }> {
    return Array.from(element.attributes ?? [])
        .map((attribute) => ({
            name: attribute.name?.trim() ?? "",
            value: attribute.value?.trim() ?? "",
        }))
        .filter((attribute) => attribute.name !== "");
}

function isElementNode(node: XMLNodeLike): boolean {
    return node.nodeType === ELEMENT_NODE;
}

function isXMLNodeLike(value: unknown): value is XMLNodeLike {
    return !!value && typeof value === "object";
}

function nodeName(node: XMLNodeLike): string {
    return node.nodeName?.trim() || "node";
}

function localName(node: XMLNodeLike): string {
    const name = nodeName(node);
    return name.includes(":") ? name.split(":").pop()! : name;
}

function collapseWhitespace(value: string): string {
    return value.trim().replace(/\s+/gu, " ");
}
