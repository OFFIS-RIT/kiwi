import { DomUtils, parseDocument } from "htmlparser2";
import render from "dom-serializer";
import type { AnyNode, Element } from "domhandler";
import type { GraphLoader } from "..";

export type HTMLLoaderMode = "content" | "html";

export class HTMLLoader implements GraphLoader {
    constructor(
        private readonly options: {
            loader: GraphLoader;
            mode?: HTMLLoaderMode;
        }
    ) {}

    async getText(): Promise<string> {
        const html = await this.options.loader.getText();
        const document = parseHTML(html);

        if ((this.options.mode ?? "content") === "html") {
            return normalizeHTML(document);
        }

        return htmlToMarkdown(document);
    }
}

export function parseHTML(input: string) {
    return parseDocument(input, {
        decodeEntities: true,
        lowerCaseAttributeNames: true,
        lowerCaseTags: true,
        recognizeSelfClosing: true,
    });
}

export function normalizeHTML(input: ReturnType<typeof parseHTML> | string): string {
    const document = typeof input === "string" ? parseHTML(input) : input;
    return render(document.children, { encodeEntities: "utf8" }).trim();
}

export function htmlToMarkdown(input: ReturnType<typeof parseHTML> | string): string {
    const document = typeof input === "string" ? parseHTML(input) : input;
    const body = DomUtils.findOne((node) => isElement(node) && node.name === "body", document.children, true);
    const nodes = body && isElement(body) ? body.children : document.children;
    return normalizeMarkdown(renderMarkdownNodes(nodes, { listDepth: 0 })).trim();
}

function renderMarkdownNodes(nodes: AnyNode[], context: { listDepth: number }): string {
    return nodes.map((node) => renderMarkdownNode(node, context)).join("");
}

function renderMarkdownNode(node: AnyNode, context: { listDepth: number }): string {
    if (isTextNode(node)) {
        return (node as { data: string }).data;
    }

    if (!isElement(node)) {
        return "";
    }

    const children = () => renderMarkdownNodes(node.children, context).trim();
    const inlineChildren = () => collapseInlineWhitespace(renderMarkdownNodes(node.children, context));

    switch (node.name) {
        case "script":
        case "style":
        case "noscript":
        case "template":
        case "head":
            return "";
        case "br":
            return "\n";
        case "hr":
            return "\n\n---\n\n";
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
            const level = Number(node.name.slice(1));
            return `\n\n${"#".repeat(level)} ${inlineChildren()}\n\n`;
        }
        case "p":
        case "div":
        case "section":
        case "article":
        case "main":
        case "header":
        case "footer":
        case "aside":
        case "nav":
            return `\n\n${children()}\n\n`;
        case "blockquote":
            return `\n\n${children()
                .split("\n")
                .map((line) => (line.trim() ? `> ${line}` : ">"))
                .join("\n")}\n\n`;
        case "strong":
        case "b":
            return `**${inlineChildren()}**`;
        case "em":
        case "i":
            return `_${inlineChildren()}_`;
        case "s":
        case "del":
            return `~~${inlineChildren()}~~`;
        case "code":
            return `\`${inlineChildren().replaceAll("`", "\\`")}\``;
        case "pre":
            return `\n\n\`\`\`\n${DomUtils.textContent(node).trim()}\n\`\`\`\n\n`;
        case "a": {
            const text = inlineChildren();
            const href = readAttribute(node, "href");
            return href ? `[${text || href}](${href})` : text;
        }
        case "img": {
            const alt = readAttribute(node, "alt") || readAttribute(node, "title");
            const src = readAttribute(node, "src");
            if (alt && src) {
                return `[Image: ${alt}](${src})`;
            }
            return alt ? `[Image: ${alt}]` : "";
        }
        case "ul":
        case "ol":
            return `\n${renderList(node, node.name === "ol", context.listDepth)}\n`;
        case "li":
            return inlineChildren();
        case "table":
            return renderTable(node);
        case "thead":
        case "tbody":
        case "tfoot":
        case "tr":
        case "td":
        case "th":
            return children();
        default:
            return renderMarkdownNodes(node.children, context);
    }
}

function renderList(node: Element, ordered: boolean, depth: number): string {
    const items = node.children.filter((child): child is Element => isElement(child) && child.name === "li");
    return items
        .map((item, index) => {
            const marker = ordered ? `${index + 1}.` : "-";
            const indent = "  ".repeat(depth);
            const childText = renderMarkdownNodes(item.children, { listDepth: depth + 1 }).trim();
            return `${indent}${marker} ${childText.replace(/\n{3,}/gu, "\n\n").replace(/\n/gu, `\n${indent}  `)}`;
        })
        .join("\n");
}

function renderTable(table: Element): string {
    const rows = DomUtils.findAll((node) => isElement(node) && node.name === "tr", [table]);
    if (rows.length === 0) {
        return `\n\n${DomUtils.textContent(table).trim()}\n\n`;
    }

    const renderedRows = rows.map((row) =>
        row.children
            .filter((cell): cell is Element => isElement(cell) && (cell.name === "td" || cell.name === "th"))
            .map((cell) =>
                collapseInlineWhitespace(renderMarkdownNodes(cell.children, { listDepth: 0 })).replaceAll("|", "\\|")
            )
    );
    const width = Math.max(...renderedRows.map((row) => row.length));
    const normalizedRows = renderedRows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
    const header = normalizedRows[0] ?? [];
    const separator = header.map(() => "---");
    const body = normalizedRows.slice(1);

    return `\n\n${[header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
}

function readAttribute(node: Element, name: string): string | null {
    const value = node.attribs?.[name]?.trim();
    return value || null;
}

function normalizeMarkdown(input: string): string {
    return input
        .replace(/[ \t]+\n/gu, "\n")
        .replace(/\n{3,}/gu, "\n\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n");
}

function collapseInlineWhitespace(input: string): string {
    return input.replace(/\s+/gu, " ").trim();
}

function isElement(node: AnyNode): node is Element {
    return node.type === "tag" || node.type === "script" || node.type === "style";
}

function isTextNode(node: AnyNode): boolean {
    return node.type === "text";
}
