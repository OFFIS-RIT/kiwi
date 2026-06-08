import { DomUtils } from "htmlparser2";
import render from "dom-serializer";
import type { AnyNode, Element } from "domhandler";
import type { GraphChunker, GraphTextChunk } from "..";
import { normalizeHTML, parseHTML } from "../loader/html";
import { resolveTextChunkSpans } from "./span";
import { chunkLinesWithPrefix, createTokenCounter, type TokenCount } from "./structured";

type HTMLChunkerOptions = {
    maxChunkSize: number;
};

export class HTMLChunker implements GraphChunker {
    constructor(private readonly options: HTMLChunkerOptions) {}

    async getChunks(input: string): Promise<string[]> {
        return (await this.getChunkSpans(input)).map((chunk) => chunk.content);
    }

    async getChunkSpans(input: string): Promise<GraphTextChunk[]> {
        const normalized = normalizeHTML(input);
        return resolveTextChunkSpans(normalized, await this.getChunkContents(normalized));
    }

    private async getChunkContents(input: string): Promise<string[]> {
        const text = input.trim();
        if (text === "") {
            return [];
        }

        const tokenCount = createTokenCounter();
        if (tokenCount(text) <= this.options.maxChunkSize) {
            return [text];
        }

        const document = parseHTML(text);
        const body = DomUtils.findOne((node) => isElement(node) && node.name === "body", document.children, true);
        const chunks = body && isElement(body)
            ? this.chunkChildren(body.children, { document, body, tokenCount })
            : this.chunkNodes(document.children, tokenCount);

        return chunks.length > 0 ? chunks : this.chunkLongHTML(text, tokenCount);
    }

    private chunkChildren(
        children: AnyNode[],
        context: { document: ReturnType<typeof parseHTML>; body: Element; tokenCount: TokenCount }
    ): string[] {
        const chunks: string[] = [];
        let current: AnyNode[] = [];

        const renderChunk = (nodes: AnyNode[]) => renderHTMLDocumentChunk(context.document, context.body, nodes);
        const flush = () => {
            if (current.length === 0) {
                return;
            }

            chunks.push(renderChunk(current));
            current = [];
        };

        for (const child of children.filter(isMeaningfulNode)) {
            const childChunk = renderChunk([child]);
            if (context.tokenCount(childChunk) > this.options.maxChunkSize && isElement(child)) {
                flush();
                chunks.push(
                    ...this.chunkElement(child, context.tokenCount).map((chunk) =>
                        renderChunk(parseHTML(chunk).children.filter(isMeaningfulNode))
                    )
                );
                continue;
            }

            const next = [...current, child];
            if (current.length > 0 && context.tokenCount(renderChunk(next)) > this.options.maxChunkSize) {
                flush();
            }

            current.push(child);
        }

        flush();
        return chunks;
    }

    private chunkElement(element: Element, tokenCount: TokenCount): string[] {
        const serialized = render([element], { encodeEntities: "utf8" }).trim();
        if (tokenCount(serialized) <= this.options.maxChunkSize) {
            return [serialized];
        }

        const children = element.children.filter(isMeaningfulNode);
        if (children.length === 0) {
            return this.chunkLongHTML(serialized, tokenCount);
        }

        return chunkLinesWithPrefix({
            lines: children.map((child) => render([child], { encodeEntities: "utf8" })),
            prefix: `<${element.name}${formatAttributes(element)}>`,
            maxChunkSize: this.options.maxChunkSize,
            tokenCount,
        }).map((chunk) => (chunk.endsWith(`</${element.name}>`) ? chunk : `${chunk}\n</${element.name}>`));
    }

    private chunkNodes(nodes: AnyNode[], tokenCount: TokenCount): string[] {
        return chunkLinesWithPrefix({
            lines: nodes.filter(isMeaningfulNode).map((node) => render([node], { encodeEntities: "utf8" })),
            maxChunkSize: this.options.maxChunkSize,
            tokenCount,
        });
    }

    private chunkLongHTML(input: string, tokenCount: TokenCount): string[] {
        return chunkLinesWithPrefix({
            lines: input.split(/\r?\n/u),
            maxChunkSize: this.options.maxChunkSize,
            tokenCount,
        });
    }
}

function renderHTMLDocumentChunk(document: ReturnType<typeof parseHTML>, body: Element, bodyChildren: AnyNode[]): string {
    const root = DomUtils.findOne((node) => isElement(node) && node.name === "html", document.children, false);
    const head = root && isElement(root)
        ? DomUtils.findOne((node) => isElement(node) && node.name === "head", root.children, false)
        : null;
    const headText = head && isElement(head) ? render(head.children, { encodeEntities: "utf8" }).trim() : "";
    const bodyAttributes = formatAttributes(body);
    const bodyText = render(bodyChildren, { encodeEntities: "utf8" }).trim();

    if (root && isElement(root)) {
        const rootAttributes = formatAttributes(root);
        const headBlock = headText ? `<head>\n${headText}\n</head>\n` : "";
        return `<html${rootAttributes}>\n${headBlock}<body${bodyAttributes}>\n${bodyText}\n</body>\n</html>`.trim();
    }

    return `<body${bodyAttributes}>\n${bodyText}\n</body>`.trim();
}

function formatAttributes(element: Element): string {
    const attributes = Object.entries(element.attribs ?? {})
        .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
        .join(" ");
    return attributes ? ` ${attributes}` : "";
}

function escapeAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function isElement(node: AnyNode): node is Element {
    return node.type === "tag" || node.type === "script" || node.type === "style";
}

function isMeaningfulNode(node: AnyNode): boolean {
    return node.type !== "text" || node.data.trim() !== "";
}
