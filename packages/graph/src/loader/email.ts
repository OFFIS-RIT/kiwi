import * as XLSX from "xlsx";
import type { GraphBinaryLoader } from "..";
import { htmlToMarkdown } from "./html";

export type EmailContainerFormat = "eml" | "msg" | "mbox";

type ParsedEmail = {
    subject?: string;
    from?: string;
    to: string[];
    cc: string[];
    date?: string;
    messageId?: string;
    body: string;
    attachments: Array<{ filename?: string; contentType?: string }>;
};

type HeaderMap = Map<string, string[]>;

type MIMEPart = {
    headers: HeaderMap;
    body: string;
};

type CFBFile = {
    name: string;
    content?: Uint8Array;
};

type CFBPackage = {
    FileIndex: CFBFile[];
};

type CFBApi = {
    read: (input: Uint8Array | ArrayBuffer, options: { type: "array" }) => CFBPackage;
};

const MSG_OLE_HEADER = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const CFB = (XLSX as unknown as { CFB: CFBApi }).CFB;

export class EmailLoader {
    constructor(
        private readonly options: {
            loader: GraphBinaryLoader;
            format?: EmailContainerFormat;
            mimeType?: string | null;
        }
    ) {}

    async getText(): Promise<string> {
        const format = this.options.format ?? inferEmailFormat(this.options.mimeType, await this.options.loader.getBinary());
        if (format === "msg") {
            return formatEmailMessage(parseMSG(await this.options.loader.getBinary()));
        }

        const text = await this.options.loader.getText();
        if (format === "mbox") {
            return formatMailbox(parseMbox(text));
        }

        return formatEmailMessage(parseEml(text));
    }
}

export function parseEml(input: string): ParsedEmail {
    const part = parseMIMEPart(input);
    const contentType = parseContentType(readHeader(part.headers, "content-type") ?? "text/plain");
    const attachments: ParsedEmail["attachments"] = [];
    const body = extractMessageBody(part, contentType, attachments);

    return {
        subject: decodeHeaderValue(readHeader(part.headers, "subject") ?? ""),
        from: decodeHeaderValue(readHeader(part.headers, "from") ?? ""),
        to: parseAddressList(readHeader(part.headers, "to")),
        cc: parseAddressList(readHeader(part.headers, "cc")),
        date: decodeHeaderValue(readHeader(part.headers, "date") ?? ""),
        messageId: decodeHeaderValue(readHeader(part.headers, "message-id") ?? ""),
        body,
        attachments,
    };
}

export function parseMbox(input: string): ParsedEmail[] {
    const normalized = input.replace(/\r\n/gu, "\n");
    const messages: string[] = [];
    let current: string[] = [];

    for (const line of normalized.split("\n")) {
        if (line.startsWith("From ") && current.length > 0) {
            messages.push(current.join("\n").trim());
            current = [];
            continue;
        }

        if (!line.startsWith("From ") || current.length > 0) {
            current.push(line);
        }
    }

    if (current.length > 0) {
        messages.push(current.join("\n").trim());
    }

    return messages.filter(Boolean).map(parseEml);
}

export function parseMSG(content: ArrayBuffer): ParsedEmail {
    const cfb = CFB.read(new Uint8Array(content), { type: "array" });
    const subject = readMSGText(cfb, "0037");
    const from = readMSGText(cfb, "0C1A") ?? readMSGText(cfb, "5D01") ?? readMSGText(cfb, "0C1F");
    const to = parseAddressList(readMSGText(cfb, "0E04"));
    const cc = parseAddressList(readMSGText(cfb, "0E03"));
    const body = readMSGText(cfb, "1000") ?? htmlToMarkdown(readMSGHTML(cfb, "1013") ?? "") ?? "";

    return {
        subject,
        from,
        to,
        cc,
        date: readMSGText(cfb, "0039"),
        messageId: readMSGText(cfb, "1035"),
        body: body.trim(),
        attachments: [],
    };
}

export function formatMailbox(messages: ParsedEmail[]): string {
    const lines = ["# Mailbox"];
    messages.forEach((message, index) => {
        lines.push("", `## Message ${index + 1}`, ...formatEmailMetadata(message), "", message.body.trim());
        if (message.attachments.length > 0) {
            lines.push("", "### Attachments", ...formatAttachments(message.attachments));
        }
    });
    return lines.join("\n").trim();
}

export function formatEmailMessage(message: ParsedEmail): string {
    const lines = ["# Email Message", ...formatEmailMetadata(message), "", message.body.trim()];
    if (message.attachments.length > 0) {
        lines.push("", "## Attachments", ...formatAttachments(message.attachments));
    }
    return lines.join("\n").trim();
}

export function inferEmailFormat(mimeType: string | null | undefined, content: ArrayBuffer): EmailContainerFormat {
    const normalizedMimeType = mimeType?.split(";")[0]?.trim().toLowerCase();
    if (normalizedMimeType === "application/vnd.ms-outlook" || matchesHeader(new Uint8Array(content), MSG_OLE_HEADER)) {
        return "msg";
    }

    if (normalizedMimeType === "application/mbox" || startsWithMboxSeparator(content)) {
        return "mbox";
    }

    return "eml";
}

function extractMessageBody(
    part: MIMEPart,
    contentType: ReturnType<typeof parseContentType>,
    attachments: ParsedEmail["attachments"]
): string {
    if (contentType.type.startsWith("multipart/")) {
        const boundary = contentType.params.get("boundary");
        if (!boundary) {
            return decodePartBody(part);
        }

        const childParts = splitMultipart(part.body, boundary);
        const textBodies: string[] = [];
        const htmlBodies: string[] = [];

        for (const child of childParts) {
            const disposition = parseHeaderParameters(readHeader(child.headers, "content-disposition") ?? "");
            const childType = parseContentType(readHeader(child.headers, "content-type") ?? "text/plain");
            const filename = disposition.params.get("filename") ?? childType.params.get("name");

            if (disposition.value === "attachment" || filename) {
                attachments.push({ filename, contentType: childType.type });
                continue;
            }

            const body = extractMessageBody(child, childType, attachments);
            if (childType.type === "text/html") {
                htmlBodies.push(body);
            } else if (body.trim()) {
                textBodies.push(body);
            }
        }

        return (textBodies.length > 0 ? textBodies : htmlBodies).join("\n\n").trim();
    }

    const decoded = decodePartBody(part);
    return contentType.type === "text/html" ? htmlToMarkdown(decoded) : decoded.trim();
}

function parseMIMEPart(input: string): MIMEPart {
    const normalized = input.replace(/\r\n/gu, "\n");
    const headerEnd = normalized.search(/\n\s*\n/u);
    const headerText = headerEnd >= 0 ? normalized.slice(0, headerEnd) : "";
    const body = headerEnd >= 0 ? normalized.slice(headerEnd).replace(/^\n\s*\n?/u, "") : normalized;

    return {
        headers: parseHeaders(headerText),
        body,
    };
}

function parseHeaders(input: string): HeaderMap {
    const headers: HeaderMap = new Map();
    let current = "";

    const flush = () => {
        const separator = current.indexOf(":");
        if (separator < 0) {
            current = "";
            return;
        }

        const name = current.slice(0, separator).trim().toLowerCase();
        const value = current.slice(separator + 1).trim();
        if (name) {
            headers.set(name, [...(headers.get(name) ?? []), value]);
        }
        current = "";
    };

    for (const line of input.split("\n")) {
        if (/^[ \t]/u.test(line)) {
            current += ` ${line.trim()}`;
            continue;
        }

        flush();
        current = line;
    }

    flush();
    return headers;
}

function readHeader(headers: HeaderMap, name: string): string | undefined {
    return headers.get(name.toLowerCase())?.join(", ");
}

function parseContentType(value: string): { type: string; params: Map<string, string> } {
    const parsed = parseHeaderParameters(value);
    return {
        type: (parsed.value || "text/plain").toLowerCase(),
        params: parsed.params,
    };
}

function parseHeaderParameters(value: string): { value: string; params: Map<string, string> } {
    const [head = "", ...rawParams] = value.split(";");
    const params = new Map<string, string>();
    for (const rawParam of rawParams) {
        const separator = rawParam.indexOf("=");
        if (separator < 0) {
            continue;
        }

        const name = rawParam.slice(0, separator).trim().toLowerCase();
        const rawValue = rawParam.slice(separator + 1).trim();
        params.set(name, trimQuotes(decodeHeaderValue(rawValue)));
    }

    return { value: head.trim().toLowerCase(), params };
}

function splitMultipart(body: string, boundary: string): MIMEPart[] {
    const delimiter = `--${boundary}`;
    const parts: string[] = [];
    let current: string[] = [];
    let inside = false;

    for (const line of body.replace(/\r\n/gu, "\n").split("\n")) {
        if (line === delimiter || line === `${delimiter}--`) {
            if (inside && current.length > 0) {
                parts.push(current.join("\n"));
                current = [];
            }
            inside = line === delimiter;
            continue;
        }

        if (inside) {
            current.push(line);
        }
    }

    return parts.map(parseMIMEPart);
}

function decodePartBody(part: MIMEPart): string {
    const transferEncoding = (readHeader(part.headers, "content-transfer-encoding") ?? "").trim().toLowerCase();
    const charset = parseContentType(readHeader(part.headers, "content-type") ?? "text/plain").params.get("charset");
    let bytes: Uint8Array;

    if (transferEncoding === "base64") {
        bytes = Buffer.from(part.body.replace(/\s+/gu, ""), "base64");
    } else if (transferEncoding === "quoted-printable") {
        bytes = decodeQuotedPrintable(part.body);
    } else {
        bytes = new TextEncoder().encode(part.body);
    }

    return decodeBytes(bytes, charset);
}

function decodeQuotedPrintable(input: string): Uint8Array {
    const normalized = input.replace(/=\r?\n/gu, "");
    const bytes: number[] = [];

    for (let index = 0; index < normalized.length; index += 1) {
        if (normalized[index] === "=" && /^[0-9A-Fa-f]{2}$/u.test(normalized.slice(index + 1, index + 3))) {
            bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
            index += 2;
            continue;
        }

        bytes.push(normalized.charCodeAt(index));
    }

    return Uint8Array.from(bytes);
}

function decodeHeaderValue(input: string): string {
    return input.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/gu, (_match, charset, encoding, value) => {
        const bytes =
            String(encoding).toUpperCase() === "B"
                ? Buffer.from(String(value), "base64")
                : decodeQuotedPrintable(String(value).replaceAll("_", " "));
        return decodeBytes(bytes, String(charset));
    });
}

function decodeBytes(bytes: Uint8Array, charset?: string | null): string {
    const normalizedCharset = charset?.trim().toLowerCase();
    try {
        return new TextDecoder((normalizedCharset || "utf-8") as never).decode(bytes);
    } catch {
        return new TextDecoder("utf-8").decode(bytes);
    }
}

function parseAddressList(value: string | undefined | null): string[] {
    return (value ?? "")
        .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/u)
        .map((item) => decodeHeaderValue(item).trim())
        .filter(Boolean);
}

function formatEmailMetadata(message: ParsedEmail): string[] {
    const lines: string[] = [];
    if (message.subject) {
        lines.push(`- Subject: ${message.subject}`);
    }
    if (message.from) {
        lines.push(`- From: ${message.from}`);
    }
    if (message.to.length > 0) {
        lines.push(`- To: ${message.to.join(", ")}`);
    }
    if (message.cc.length > 0) {
        lines.push(`- Cc: ${message.cc.join(", ")}`);
    }
    if (message.date) {
        lines.push(`- Date: ${message.date}`);
    }
    if (message.messageId) {
        lines.push(`- Message-ID: ${message.messageId}`);
    }
    return lines;
}

function formatAttachments(attachments: ParsedEmail["attachments"]): string[] {
    return attachments.map((attachment) => {
        const label = attachment.filename ?? "unnamed attachment";
        return `- ${label}${attachment.contentType ? ` (${attachment.contentType})` : ""}`;
    });
}

function readMSGText(cfb: CFBPackage, propertyId: string): string | undefined {
    return readMSGStream(cfb, `${propertyId}001F`, "utf-16le") ?? readMSGStream(cfb, `${propertyId}001E`, "latin1");
}

function readMSGHTML(cfb: CFBPackage, propertyId: string): string | undefined {
    return (
        readMSGStream(cfb, `${propertyId}001F`, "utf-16le") ??
        readMSGStream(cfb, `${propertyId}001E`, "latin1") ??
        readMSGStream(cfb, `${propertyId}0102`, "utf-8")
    );
}

function readMSGStream(cfb: CFBPackage, suffix: string, encoding: string): string | undefined {
    const stream = cfb.FileIndex.find((file) => file.name.toLowerCase().endsWith(suffix.toLowerCase()));
    if (!stream?.content) {
        return undefined;
    }

    return decodeBytes(stream.content, encoding).replace(/\0+$/gu, "").trim() || undefined;
}

function startsWithMboxSeparator(content: ArrayBuffer): boolean {
    return new TextDecoder().decode(new Uint8Array(content).slice(0, 256)).startsWith("From ");
}

function matchesHeader(bytes: Uint8Array, header: Uint8Array): boolean {
    if (bytes.length < header.length) {
        return false;
    }

    for (let index = 0; index < header.length; index += 1) {
        if (bytes[index] !== header[index]) {
            return false;
        }
    }

    return true;
}

function trimQuotes(value: string): string {
    return value.replace(/^"|"$/gu, "");
}
