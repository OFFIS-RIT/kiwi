import { describe, expect, test } from "bun:test";
import { CalendarChunker } from "../../chunking/calendar";
import { VCardChunker } from "../../chunking/vcard";
import { BufferedGraphBinaryLoader } from "../factory";
import { CalendarLoader } from "../calendar";
import { VCardLoader } from "../vcard";

describe("CalendarLoader", () => {
    test("formats ICS events with folded lines and attendees", async () => {
        const ics = [
            "BEGIN:VCALENDAR",
            "BEGIN:VEVENT",
            "SUMMARY:Planning",
            "DTSTART:20260101T100000Z",
            "DTEND:20260101T110000Z",
            "LOCATION:Room 1",
            "ORGANIZER;CN=Alice:mailto:alice@example.com",
            "ATTENDEE;CN=Bob:mailto:bob@example.com",
            "DESCRIPTION:Discuss roadmap\\nAnd milestones",
            "END:VEVENT",
            "END:VCALENDAR",
        ].join("\r\n");

        const text = await new CalendarLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(encode(ics))),
        }).getText();

        expect(text).toContain("# Calendar");
        expect(text).toContain("## Event 1: Planning");
        expect(text).toContain("- Organizer: Alice <alice@example.com>");
        expect(text).toContain("  - Bob <bob@example.com>");
        expect(text).toContain("Discuss roadmap\nAnd milestones");
    });
});

describe("VCardLoader", () => {
    test("formats vCards with repeated contact fields", async () => {
        const vcard = [
            "BEGIN:VCARD",
            "VERSION:4.0",
            "FN:Alice Example",
            "ORG:Example Inc",
            "EMAIL:alice@example.com",
            "TEL:+491234",
            "ADR:;;Main Street 1;Berlin;;;Germany",
            "END:VCARD",
        ].join("\n");

        const text = await new VCardLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(encode(vcard))),
        }).getText();

        expect(text).toContain("# Contacts");
        expect(text).toContain("## Contact 1: Alice Example");
        expect(text).toContain("- Organization: Example Inc");
        expect(text).toContain("- Email: alice@example.com");
        expect(text).toContain("- Address: Main Street 1, Berlin, Germany");
    });
});

describe("record chunkers", () => {
    test("chunks calendar and vCard records by record heading", async () => {
        const calendar = ["# Calendar", "", "## Event 1: One", "one ".repeat(50), "", "## Event 2: Two", "two ".repeat(50)].join("\n");
        const contacts = ["# Contacts", "", "## Contact 1: One", "one ".repeat(50), "", "## Contact 2: Two", "two ".repeat(50)].join("\n");

        expect(await new CalendarChunker({ maxChunkSize: 80 }).getChunks(calendar)).toHaveLength(2);
        expect(await new VCardChunker({ maxChunkSize: 80 }).getChunks(contacts)).toHaveLength(2);
    });
});

function encode(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
