import type { GraphLoader } from "../types";

type CalendarProperty = {
    name: string;
    params: Map<string, string>;
    value: string;
};

type CalendarItem = {
    kind: "Event" | "Todo" | "Journal";
    properties: CalendarProperty[];
};

export class CalendarLoader implements GraphLoader {
    constructor(private readonly options: { loader: GraphLoader }) {}

    async getText(): Promise<string> {
        return formatCalendar(parseCalendar(await this.options.loader.getText()));
    }
}

export function parseCalendar(input: string): CalendarItem[] {
    const lines = unfoldStructuredLines(input);
    const items: CalendarItem[] = [];
    let current: CalendarItem | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (/^BEGIN:VEVENT$/iu.test(trimmed)) {
            current = { kind: "Event", properties: [] };
            continue;
        }
        if (/^BEGIN:VTODO$/iu.test(trimmed)) {
            current = { kind: "Todo", properties: [] };
            continue;
        }
        if (/^BEGIN:VJOURNAL$/iu.test(trimmed)) {
            current = { kind: "Journal", properties: [] };
            continue;
        }
        if (/^END:(?:VEVENT|VTODO|VJOURNAL)$/iu.test(trimmed)) {
            if (current) {
                items.push(current);
            }
            current = null;
            continue;
        }

        if (current) {
            const property = parseStructuredProperty(line);
            if (property) {
                current.properties.push(property);
            }
        }
    }

    return items;
}

export function formatCalendar(items: CalendarItem[]): string {
    const lines = ["# Calendar"];

    items.forEach((item, index) => {
        const summary = readFirst(item.properties, "SUMMARY") || `${item.kind} ${index + 1}`;
        lines.push("", `## ${item.kind} ${index + 1}: ${summary}`);
        pushLine(lines, "Start", readFirst(item.properties, "DTSTART"));
        pushLine(lines, "End", readFirst(item.properties, "DTEND"));
        pushLine(lines, "Due", readFirst(item.properties, "DUE"));
        pushLine(lines, "Status", readFirst(item.properties, "STATUS"));
        pushLine(lines, "Location", readFirst(item.properties, "LOCATION"));
        pushLine(lines, "Organizer", formatParticipant(readProperty(item.properties, "ORGANIZER")));

        const attendees = readAllProperties(item.properties, "ATTENDEE").map(formatParticipant).filter(Boolean);
        if (attendees.length > 0) {
            lines.push("- Attendees:", ...attendees.map((attendee) => `  - ${attendee}`));
        }

        const description = readFirst(item.properties, "DESCRIPTION");
        if (description) {
            lines.push("", description);
        }
    });

    return lines.join("\n").trim();
}

function formatParticipant(property: CalendarProperty | undefined): string | undefined {
    if (!property) {
        return undefined;
    }

    const commonName = property.params.get("CN");
    const value = property.value.replace(/^mailto:/iu, "");
    return commonName ? `${commonName} <${value}>` : value;
}

export function unfoldStructuredLines(input: string): string[] {
    const lines: string[] = [];
    for (const rawLine of input.replace(/\r\n/gu, "\n").split("\n")) {
        if (/^[ \t]/u.test(rawLine) && lines.length > 0) {
            lines[lines.length - 1] += rawLine.slice(1);
            continue;
        }

        lines.push(rawLine);
    }

    return lines;
}

export function parseStructuredProperty(line: string): CalendarProperty | null {
    const separator = findUnquotedSeparator(line, ":");
    if (separator < 0) {
        return null;
    }

    const nameAndParams = line.slice(0, separator);
    const [rawName = "", ...rawParams] = splitQuotedParts(nameAndParams, ";");
    const params = new Map<string, string>();
    for (const rawParam of rawParams) {
        const paramSeparator = findUnquotedSeparator(rawParam, "=");
        if (paramSeparator < 0) {
            continue;
        }

        params.set(
            rawParam.slice(0, paramSeparator).trim().toUpperCase(),
            trimQuotes(unescapeStructuredValue(rawParam.slice(paramSeparator + 1).trim()))
        );
    }

    return {
        name: rawName.trim().toUpperCase(),
        params,
        value: unescapeStructuredValue(line.slice(separator + 1).trim()),
    };
}

function readProperty(properties: CalendarProperty[], name: string): CalendarProperty | undefined {
    return properties.find((property) => property.name === name);
}

function readAllProperties(properties: CalendarProperty[], name: string): CalendarProperty[] {
    return properties.filter((property) => property.name === name);
}

function readFirst(properties: CalendarProperty[], name: string): string | undefined {
    return readProperty(properties, name)?.value;
}

function pushLine(lines: string[], label: string, value: string | undefined): void {
    if (value) {
        lines.push(`- ${label}: ${value}`);
    }
}

function unescapeStructuredValue(value: string): string {
    return value.replace(/\\n/giu, "\n").replace(/\\,/gu, ",").replace(/\\;/gu, ";").replace(/\\\\/gu, "\\");
}

function trimQuotes(value: string): string {
    return value.replace(/^"|"$/gu, "");
}

function findUnquotedSeparator(value: string, separator: string): number {
    let quoted = false;
    let escaped = false;

    for (let index = 0; index < value.length; index += 1) {
        const char = value[index]!;
        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === "\\") {
            escaped = true;
            continue;
        }

        if (char === '"') {
            quoted = !quoted;
            continue;
        }

        if (char === separator && !quoted) {
            return index;
        }
    }

    return -1;
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
