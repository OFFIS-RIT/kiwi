import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { EmailChunker } from "../../chunking/email";
import { BufferedGraphBinaryLoader } from "../factory";
import { EmailLoader } from "../email";

describe("EmailLoader", () => {
    test("extracts text from multipart EML and records attachments", async () => {
        const eml = [
            "Subject: =?UTF-8?Q?Project_update?=",
            "From: Alice <alice@example.com>",
            "To: Bob <bob@example.com>",
            "Date: Tue, 01 Jan 2026 10:00:00 +0000",
            "Content-Type: multipart/mixed; boundary=\"outer\"",
            "",
            "--outer",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: quoted-printable",
            "",
            "Hello=2C Bob.",
            "--outer",
            "Content-Type: application/pdf; name=\"brief.pdf\"",
            "Content-Disposition: attachment; filename=\"brief.pdf\"",
            "",
            "ignored",
            "--outer--",
        ].join("\r\n");

        const text = await new EmailLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(encode(eml))),
            format: "eml",
        }).getText();

        expect(text).toContain("# Email Message");
        expect(text).toContain("- Subject: Project update");
        expect(text).toContain("- From: Alice <alice@example.com>");
        expect(text).toContain("Hello, Bob.");
        expect(text).toContain("- brief.pdf (application/pdf)");
    });

    test("extracts multiple messages from MBOX", async () => {
        const mbox = [
            "From alice@example.com Tue Jan 01 00:00:00 2026",
            "Subject: First",
            "From: Alice <alice@example.com>",
            "",
            "First body",
            "From bob@example.com Tue Jan 02 00:00:00 2026",
            "Subject: Second",
            "From: Bob <bob@example.com>",
            "",
            "Second body",
        ].join("\n");

        const text = await new EmailLoader({
            loader: new BufferedGraphBinaryLoader(toArrayBuffer(encode(mbox))),
            format: "mbox",
        }).getText();

        expect(text).toContain("# Mailbox");
        expect(text).toContain("## Message 1");
        expect(text).toContain("- Subject: First");
        expect(text).toContain("## Message 2");
        expect(text).toContain("- Subject: Second");
    });

    test("extracts common Outlook MSG MAPI streams", async () => {
        const text = await new EmailLoader({
            loader: new BufferedGraphBinaryLoader(buildSyntheticMSG()),
            format: "msg",
        }).getText();

        expect(text).toContain("# Email Message");
        expect(text).toContain("- Subject: MSG Subject");
        expect(text).toContain("- From: Sender Name");
        expect(text).toContain("MSG body text");
    });
});

describe("EmailChunker", () => {
    test("keeps mailbox message sections together", async () => {
        const input = [
            "# Mailbox",
            "",
            "## Message 1",
            "- Subject: One",
            "",
            "one ".repeat(50),
            "",
            "## Message 2",
            "- Subject: Two",
            "",
            "two ".repeat(50),
        ].join("\n");

        const chunks = await new EmailChunker({ maxChunkSize: 80 }).getChunks(input);

        expect(chunks.length).toBe(2);
        expect(chunks[0]).toContain("# Mailbox");
        expect(chunks[0]).toContain("## Message 1");
        expect(chunks[1]).toContain("## Message 2");
    });
});

type CFBShape = {
    utils: {
        cfb_new: () => unknown;
        cfb_add: (cfb: unknown, name: string, content: Uint8Array) => void;
    };
    write: (cfb: unknown, options: { type: "array" }) => Uint8Array;
};

function buildSyntheticMSG(): ArrayBuffer {
    const cfbApi = (XLSX as unknown as { CFB: CFBShape }).CFB;
    const cfb = cfbApi.utils.cfb_new();
    cfbApi.utils.cfb_add(cfb, "__substg1.0_0037001F", utf16le("MSG Subject"));
    cfbApi.utils.cfb_add(cfb, "__substg1.0_0C1A001F", utf16le("Sender Name"));
    cfbApi.utils.cfb_add(cfb, "__substg1.0_1000001F", utf16le("MSG body text"));
    return toArrayBuffer(cfbApi.write(cfb, { type: "array" }));
}

function utf16le(value: string): Uint8Array {
    return Buffer.from(`${value}\0`, "utf16le");
}

function encode(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
