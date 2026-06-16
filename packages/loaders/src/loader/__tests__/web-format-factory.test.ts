import { describe, expect, test } from "bun:test";
import { createDetectedGraphLoader, detectGraphFileFormat } from "../factory";

describe("web and structured format detection", () => {
    test("detects HTML email calendar and vCard content", () => {
        expect(
            detectGraphFileFormat({
                content: toArrayBuffer(encode("<!doctype html><html><body>Hi</body></html>")),
                declaredType: "text",
                mimeType: "text/plain",
            })
        ).toMatchObject({ fileType: "html", loaderKind: "html", mimeType: "text/html", sniffed: true });

        expect(
            detectGraphFileFormat({
                content: toArrayBuffer(encode("Subject: Hello\nFrom: a@example.com\n\nBody")),
                declaredType: "text",
                mimeType: "text/plain",
            })
        ).toMatchObject({ fileType: "email", loaderKind: "email", mimeType: "message/rfc822", sniffed: true });

        expect(
            detectGraphFileFormat({
                content: toArrayBuffer(encode("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Hi\nEND:VEVENT\nEND:VCALENDAR")),
                declaredType: "text",
                mimeType: "text/plain",
            })
        ).toMatchObject({ fileType: "calendar", loaderKind: "calendar", mimeType: "text/calendar", sniffed: true });

        expect(
            detectGraphFileFormat({
                content: toArrayBuffer(encode("BEGIN:VCARD\nFN:Alice\nEND:VCARD")),
                declaredType: "text",
                mimeType: "text/plain",
            })
        ).toMatchObject({ fileType: "vcard", loaderKind: "vcard", mimeType: "text/vcard", sniffed: true });
    });

    test("creates loaders for new routed formats", async () => {
        const html = createDetectedGraphLoader({
            content: toArrayBuffer(encode("<html><body><h1>Hello</h1></body></html>")),
            declaredType: "html",
            mimeType: "text/html",
        });
        await expect(html.loader.getText()).resolves.toContain("# Hello");

        const email = createDetectedGraphLoader({
            content: toArrayBuffer(encode("Subject: Hi\nFrom: a@example.com\n\nBody")),
            declaredType: "email",
            mimeType: "message/rfc822",
        });
        await expect(email.loader.getText()).resolves.toContain("# Email Message");

        const calendar = createDetectedGraphLoader({
            content: toArrayBuffer(encode("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Meet\nEND:VEVENT\nEND:VCALENDAR")),
            declaredType: "calendar",
            mimeType: "text/calendar",
        });
        await expect(calendar.loader.getText()).resolves.toContain("## Event 1: Meet");

        const vcard = createDetectedGraphLoader({
            content: toArrayBuffer(encode("BEGIN:VCARD\nFN:Alice\nEND:VCARD")),
            declaredType: "vcard",
            mimeType: "text/vcard",
        });
        await expect(vcard.loader.getText()).resolves.toContain("## Contact 1: Alice");
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
