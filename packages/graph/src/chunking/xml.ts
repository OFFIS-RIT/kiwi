import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { GraphChunker, GraphTextChunk } from "..";
import { resolveTextChunkSpans } from "./span";
import { chunkLinesWithPrefix, createTokenCounter, formatPathChunk, type TokenCount } from "./structured";

type XMLChunkerOptions = {
    maxChunkSize: number;
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

type ParsedXMLRoot = {
    root: XMLNodeLike;
    preamble: string;
};

const XML_MIME_TYPE = "application/xml";
const XML_ERROR_HANDLER = () => undefined;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const COMMENT_NODE = 8;

export class XMLChunker implements GraphChunker {
    private readonly maxChunkSize: number;

    constructor(options: XMLChunkerOptions) {
        this.maxChunkSize = options.maxChunkSize;
    }

    async getChunks(input: string): Promise<string[]> {
        return (await this.getChunkSpans(input)).map((chunk) => chunk.content);
    }

    async getChunkSpans(input: string): Promise<GraphTextChunk[]> {
        return resolveTextChunkSpans(input, await this.getChunkContents(input));
    }

    private async getChunkContents(input: string): Promise<string[]> {
        const text = input.trim();
        if (text === "") {
            return [];
        }

        const tokenCount = createTokenCounter();
        if (tokenCount(text) <= this.maxChunkSize) {
            return [text];
        }

        const parsed = parseXMLRoot(text);
        if (!parsed) {
            return [text];
        }

        const chunks = this.chunkElement(parsed.root, `/${nodeName(parsed.root)}`, tokenCount);
        if (parsed.preamble && chunks.length > 0) {
            chunks[0] = `${parsed.preamble}\n${chunks[0]}`;
        }

        return chunks;
    }

    private chunkElement(element: XMLNodeLike, path: string, tokenCount: TokenCount): string[] {
        const serialized = serializeNode(element);
        if (tokenCount(serialized) <= this.maxChunkSize) {
            return [formatPathChunk(path, serialized)];
        }

        const children = significantChildren(element);
        if (children.length === 0) {
            return this.chunkLongXML(serialized, path, tokenCount);
        }

        const chunks: string[] = [];
        let currentFragments: string[] = [];

        const flush = () => {
            if (currentFragments.length === 0) {
                return;
            }

            chunks.push(formatPathChunk(path, wrapElement(element, currentFragments.join("\n"))));
            currentFragments = [];
        };

        for (const child of childrenWithPaths(children, path)) {
            const childText = serializeNode(child.node);
            const framedChildText = formatPathChunk(path, wrapElement(element, childText));

            if (tokenCount(framedChildText) > this.maxChunkSize) {
                flush();
                if (isElementNode(child.node)) {
                    chunks.push(...this.chunkElement(child.node, child.path, tokenCount));
                } else {
                    chunks.push(...this.chunkLongXML(childText, child.path, tokenCount));
                }
                continue;
            }

            const nextFragments = [...currentFragments, childText];
            const nextText = formatPathChunk(path, wrapElement(element, nextFragments.join("\n")));
            if (currentFragments.length > 0 && tokenCount(nextText) > this.maxChunkSize) {
                flush();
            }

            currentFragments.push(childText);
        }

        flush();
        return chunks.length > 0 ? chunks : this.chunkLongXML(serialized, path, tokenCount);
    }

    private chunkLongXML(text: string, path: string, tokenCount: TokenCount): string[] {
        return chunkLinesWithPrefix({
            lines: text.split(/\r?\n/u),
            prefix: path === "$" ? undefined : `Path: ${path}`,
            maxChunkSize: this.maxChunkSize,
            tokenCount,
        });
    }
}

function parseXMLRoot(input: string): ParsedXMLRoot | null {
    try {
        const document = new DOMParser({ errorHandler: XML_ERROR_HANDLER }).parseFromString(
            input,
            XML_MIME_TYPE
        ) as unknown as { documentElement?: XMLNodeLike };
        const root = document.documentElement;
        if (!root || !isElementNode(root) || localName(root) === "parsererror") {
            return null;
        }

        return {
            root,
            preamble: readXMLPreamble(input, nodeName(root)),
        };
    } catch {
        return null;
    }
}

function readXMLPreamble(input: string, rootName: string): string {
    const rootPattern = new RegExp(`<\\s*${escapeRegExp(rootName)}(?:\\s|>|/)`, "u");
    const rootIndex = input.search(rootPattern);
    return rootIndex > 0 ? input.slice(0, rootIndex).trim() : "";
}

function significantChildren(node: XMLNodeLike): XMLNodeLike[] {
    return Array.from(node.childNodes ?? [])
        .filter(isXMLNodeLike)
        .filter((child) => {
            if (isElementNode(child) || child.nodeType === COMMENT_NODE || child.nodeType === CDATA_SECTION_NODE) {
                return true;
            }

            return child.nodeType === TEXT_NODE && (child.textContent ?? "").trim() !== "";
        });
}

function childrenWithPaths(children: XMLNodeLike[], parentPath: string): Array<{ node: XMLNodeLike; path: string }> {
    const elementCounts = new Map<string, number>();
    let textCount = 0;
    let commentCount = 0;

    return children.map((node) => {
        if (isElementNode(node)) {
            const name = nodeName(node);
            const index = (elementCounts.get(name) ?? 0) + 1;
            elementCounts.set(name, index);
            return { node, path: `${parentPath}/${name}[${index}]` };
        }

        if (node.nodeType === COMMENT_NODE) {
            commentCount += 1;
            return { node, path: `${parentPath}/comment()[${commentCount}]` };
        }

        textCount += 1;
        return { node, path: `${parentPath}/text()[${textCount}]` };
    });
}

function wrapElement(element: XMLNodeLike, body: string): string {
    const name = nodeName(element);
    const attributes = serializeAttributes(element);
    const opening = attributes ? `<${name} ${attributes}>` : `<${name}>`;
    return `${opening}\n${body.trim()}\n</${name}>`;
}

function serializeAttributes(element: XMLNodeLike): string {
    return Array.from(element.attributes ?? [])
        .map((attribute) => {
            const name = attribute.name?.trim();
            if (!name) {
                return "";
            }

            return `${name}="${escapeAttribute(attribute.value ?? "")}"`;
        })
        .filter(Boolean)
        .join(" ");
}

function serializeNode(node: XMLNodeLike): string {
    return new XMLSerializer().serializeToString(node as never).trim();
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

function escapeAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
