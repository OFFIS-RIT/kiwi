import * as XLSX from "xlsx";
import type { GraphBinaryLoader } from "../types";
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
    body: Uint8Array;
};

type ByteLine = {
    line: string;
    start: number;
    end: number;
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
        const content = await this.options.loader.getBinary();
        const format = this.options.format ?? inferEmailFormat(this.options.mimeType, content);
        if (format === "msg") {
            return formatEmailMessage(parseMSG(content));
        }

        if (format === "mbox") {
            return formatMailbox(parseMbox(content));
        }

        return formatEmailMessage(parseEml(content));
    }
}

export function parseEml(input: string | Uint8Array | ArrayBuffer): ParsedEmail {
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

export function parseMbox(input: string | Uint8Array | ArrayBuffer): ParsedEmail[] {
    const bytes = toBytes(input);
    const messages: Uint8Array[] = [];
    let currentStart: number | null = null;

    for (const line of splitByteLines(bytes)) {
        if (isMboxSeparator(line.line)) {
            if (currentStart !== null && line.start > currentStart) {
                messages.push(trimBytes(bytes.slice(currentStart, line.start)));
            }
            currentStart = line.end;
            continue;
        }
    }

    if (currentStart === null) {
        messages.push(trimBytes(bytes));
    } else if (currentStart < bytes.length) {
        messages.push(trimBytes(bytes.slice(currentStart)));
    }

    return messages.filter((message) => message.length > 0).map(parseEml);
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

function parseMIMEPart(input: string | Uint8Array | ArrayBuffer): MIMEPart {
    const bytes = toBytes(input);
    const split = findHeaderBodySplit(bytes);
    const headerText = split ? byteString(bytes.subarray(0, split.headerEnd)).replace(/\r\n/gu, "\n") : "";
    const body = split ? bytes.slice(split.bodyStart) : bytes;

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
    const [head = "", ...rawParams] = splitQuotedParts(value, ";");
    const params = new Map<string, string>();
    const extendedParams = new Map<string, string>();
    const continuedParams = new Map<string, Array<{ index: number; encoded: boolean; value: string }>>();

    for (const rawParam of rawParams) {
        const separator = rawParam.indexOf("=");
        if (separator < 0) {
            continue;
        }

        const rawName = rawParam.slice(0, separator).trim().toLowerCase();
        const rawValue = rawParam.slice(separator + 1).trim();
        const continued = rawName.match(/^(.+)\*(\d+)(\*)?$/u);
        if (continued) {
            const name = continued[1]!;
            const index = Number(continued[2]);
            continuedParams.set(name, [
                ...(continuedParams.get(name) ?? []),
                { index, encoded: continued[3] === "*", value: rawValue },
            ]);
            continue;
        }

        if (rawName.endsWith("*")) {
            extendedParams.set(rawName.slice(0, -1), decodeExtendedHeaderParameter(rawValue));
            continue;
        }

        params.set(rawName, decodeRegularHeaderParameter(rawValue));
    }

    for (const [name, value] of extendedParams) {
        params.set(name, value);
    }

    for (const [name, parts] of continuedParams) {
        const sortedParts = [...parts].sort((left, right) => left.index - right.index);
        const value = sortedParts.map((part) => trimQuotes(part.value)).join("");
        params.set(
            name,
            sortedParts.some((part) => part.encoded)
                ? decodeExtendedHeaderParameter(value)
                : decodeRegularHeaderParameter(value)
        );
    }

    return { value: head.trim().toLowerCase(), params };
}

function decodeRegularHeaderParameter(value: string): string {
    return trimQuotes(decodeHeaderValue(value));
}

function decodeExtendedHeaderParameter(value: string): string {
    const unquoted = trimQuotes(value);
    const charsetSeparator = unquoted.indexOf("'");
    const languageSeparator = charsetSeparator >= 0 ? unquoted.indexOf("'", charsetSeparator + 1) : -1;

    if (charsetSeparator > 0 && languageSeparator >= 0) {
        return decodeBytes(
            percentDecodeBytes(unquoted.slice(languageSeparator + 1)),
            unquoted.slice(0, charsetSeparator)
        );
    }

    try {
        return decodeURIComponent(unquoted);
    } catch {
        return decodeHeaderValue(unquoted);
    }
}

function splitMultipart(body: Uint8Array, boundary: string): MIMEPart[] {
    const delimiter = `--${boundary}`;
    const closingDelimiter = `${delimiter}--`;
    const parts: Uint8Array[] = [];
    let partStart: number | null = null;

    for (const line of splitByteLines(body)) {
        const marker = line.line.trimEnd();
        if (marker === delimiter || marker === closingDelimiter) {
            if (partStart !== null && line.start > partStart) {
                parts.push(body.slice(partStart, line.start));
            }

            if (marker === closingDelimiter) {
                break;
            }

            partStart = line.end;
        }
    }

    return parts.map(parseMIMEPart);
}

function decodePartBody(part: MIMEPart): string {
    const transferEncoding = (readHeader(part.headers, "content-transfer-encoding") ?? "").trim().toLowerCase();
    const charset = parseContentType(readHeader(part.headers, "content-type") ?? "text/plain").params.get("charset");
    let bytes: Uint8Array;

    if (transferEncoding === "base64") {
        bytes = Buffer.from(byteString(part.body).replace(/\s+/gu, ""), "base64");
    } else if (transferEncoding === "quoted-printable") {
        bytes = decodeQuotedPrintable(byteString(part.body));
    } else {
        bytes = part.body;
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

function percentDecodeBytes(input: string): Uint8Array {
    const bytes: number[] = [];
    const textEncoder = new TextEncoder();

    for (let index = 0; index < input.length; index += 1) {
        if (input[index] === "%" && /^[0-9A-Fa-f]{2}$/u.test(input.slice(index + 1, index + 3))) {
            bytes.push(Number.parseInt(input.slice(index + 1, index + 3), 16));
            index += 2;
            continue;
        }

        bytes.push(...textEncoder.encode(input[index]!));
    }

    return Uint8Array.from(bytes);
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
    return isMboxSeparator(byteString(new Uint8Array(content).subarray(0, 256)).split(/\r?\n/u)[0] ?? "");
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

export function isMboxSeparator(line: string): boolean {
    return /^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}/iu.test(line.trimEnd());
}

function splitQuotedParts(value: string, separator: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quoted = false;
    let escaped = false;

    for (const char of value) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === "\\") {
            current += char;
            escaped = true;
            continue;
        }

        if (char === '"') {
            quoted = !quoted;
            current += char;
            continue;
        }

        if (char === separator && !quoted) {
            parts.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    parts.push(current);
    return parts;
}

function toBytes(input: string | Uint8Array | ArrayBuffer): Uint8Array {
    if (typeof input === "string") {
        return new TextEncoder().encode(input);
    }

    return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function findHeaderBodySplit(bytes: Uint8Array): { headerEnd: number; bodyStart: number } | null {
    for (const line of splitByteLines(bytes)) {
        if (line.line.trim() === "") {
            return {
                headerEnd: line.start,
                bodyStart: line.end,
            };
        }
    }

    return null;
}

function splitByteLines(bytes: Uint8Array): ByteLine[] {
    const lines: ByteLine[] = [];
    let start = 0;

    while (start < bytes.length) {
        let contentEnd = start;
        while (contentEnd < bytes.length && bytes[contentEnd] !== 0x0a && bytes[contentEnd] !== 0x0d) {
            contentEnd += 1;
        }

        let end = contentEnd;
        if (end < bytes.length) {
            end += bytes[end] === 0x0d && bytes[end + 1] === 0x0a ? 2 : 1;
        }

        lines.push({
            line: byteString(bytes.subarray(start, contentEnd)),
            start,
            end,
        });
        start = end;
    }

    return lines;
}

function byteString(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("latin1");
}

function trimBytes(bytes: Uint8Array): Uint8Array {
    let start = 0;
    let end = bytes.length;

    while (start < end && isWhitespaceByte(bytes[start]!)) {
        start += 1;
    }

    while (end > start && isWhitespaceByte(bytes[end - 1]!)) {
        end -= 1;
    }

    return bytes.slice(start, end);
}

function isWhitespaceByte(byte: number): boolean {
    return byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d || byte === 0x20;
}
