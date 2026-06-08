import type { GraphLoader } from "..";
import { parseStructuredProperty, unfoldStructuredLines } from "./calendar";

type VCardProperty = NonNullable<ReturnType<typeof parseStructuredProperty>>;

type VCard = {
    properties: VCardProperty[];
};

export class VCardLoader implements GraphLoader {
    constructor(private readonly options: { loader: GraphLoader }) {}

    async getText(): Promise<string> {
        return formatVCards(parseVCards(await this.options.loader.getText()));
    }
}

export function parseVCards(input: string): VCard[] {
    const cards: VCard[] = [];
    let current: VCard | null = null;

    for (const line of unfoldStructuredLines(input)) {
        const trimmed = line.trim();
        if (/^BEGIN:VCARD$/iu.test(trimmed)) {
            current = { properties: [] };
            continue;
        }
        if (/^END:VCARD$/iu.test(trimmed)) {
            if (current) {
                cards.push(current);
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

    return cards;
}

export function formatVCards(cards: VCard[]): string {
    const lines = ["# Contacts"];

    cards.forEach((card, index) => {
        const name = readFirst(card.properties, "FN") ?? formatStructuredName(readFirst(card.properties, "N"));
        lines.push("", `## Contact ${index + 1}: ${name || `Contact ${index + 1}`}`);
        pushLine(lines, "Full name", name);
        pushLine(lines, "Organization", readFirst(card.properties, "ORG"));
        pushLine(lines, "Title", readFirst(card.properties, "TITLE"));
        pushRepeated(lines, "Email", readAll(card.properties, "EMAIL"));
        pushRepeated(lines, "Phone", readAll(card.properties, "TEL"));
        pushRepeated(lines, "Address", readAll(card.properties, "ADR").map(formatAddress));
        pushRepeated(lines, "URL", readAll(card.properties, "URL"));
        pushLine(lines, "Birthday", readFirst(card.properties, "BDAY"));

        const note = readFirst(card.properties, "NOTE");
        if (note) {
            lines.push("", note);
        }
    });

    return lines.join("\n").trim();
}

function readFirst(properties: VCardProperty[], name: string): string | undefined {
    return properties.find((property) => property.name === name)?.value;
}

function readAll(properties: VCardProperty[], name: string): string[] {
    return properties.filter((property) => property.name === name).map((property) => property.value).filter(Boolean);
}

function formatStructuredName(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }

    const [family, given, additional, prefix, suffix] = value.split(";").map((part) => part.trim()).filter(Boolean);
    return [prefix, given, additional, family, suffix].filter(Boolean).join(" ") || value;
}

function formatAddress(value: string): string {
    return value
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .join(", ");
}

function pushRepeated(lines: string[], label: string, values: string[]): void {
    const filtered = values.filter(Boolean);
    if (filtered.length === 0) {
        return;
    }

    if (filtered.length === 1) {
        lines.push(`- ${label}: ${filtered[0]}`);
        return;
    }

    lines.push(`- ${label}:`, ...filtered.map((value) => `  - ${value}`));
}

function pushLine(lines: string[], label: string, value: string | undefined): void {
    if (value) {
        lines.push(`- ${label}: ${value}`);
    }
}
