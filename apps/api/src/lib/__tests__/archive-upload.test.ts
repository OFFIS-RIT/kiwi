import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
    checkArchiveUploadTools,
    expandArchiveUploadFiles,
    extractArchiveUploadFile,
    isArchiveUploadFile,
} from "../archive-upload";

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256).map((_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
});

const archiveToolCheck = await checkArchiveUploadTools();
const missingTools = archiveToolCheck.ok ? [] : archiveToolCheck.missing;
if (process.env.CI === "true" && missingTools.length > 0) {
    throw new Error(`Missing archive upload tools in CI: ${missingTools.join(", ")}`);
}
const bsdtarTest = missingTools.includes("bsdtar") ? test.skip : test;
const gzipTest = missingTools.includes("gzip") ? test.skip : test;

describe("isArchiveUploadFile", () => {
    test("detects archive uploads by extension and MIME type", () => {
        expect(isArchiveUploadFile(new File([""], "documents.zip", { type: "" }))).toBe(true);
        expect(isArchiveUploadFile(new File([""], "documents.tar.gz", { type: "" }))).toBe(true);
        expect(isArchiveUploadFile(new File([""], "documents.rar", { type: "" }))).toBe(true);
        expect(isArchiveUploadFile(new File([""], "documents.7z", { type: "" }))).toBe(true);
        expect(isArchiveUploadFile(new File([""], "notes.txt.gz", { type: "" }))).toBe(true);
        expect(isArchiveUploadFile(new File([""], "upload", { type: "application/x-tar" }))).toBe(true);
        expect(isArchiveUploadFile(new File([""], "report.docx", { type: "" }))).toBe(false);
    });
});

describe("expandArchiveUploadFiles", () => {
    test("replaces archive uploads with extracted files", async () => {
        const archive = new File(["archive"], "documents.zip", { type: "application/zip" });
        const plain = new File(["plain"], "plain.txt", { type: "text/plain" });
        const result = await expandArchiveUploadFiles([archive, plain], async (file) => [
            new File([await file.text()], "first.txt"),
            new File(["second"], "second.txt"),
        ]);

        expect(result.ok).toBe(true);
        if (!result.ok) {
            throw new Error("expected archive expansion to succeed");
        }

        expect(result.files.map((file) => file.name)).toEqual(["first.txt", "second.txt", "plain.txt"]);
        await expect(result.files[0]?.text()).resolves.toBe("archive");
    });

    test("returns unsupported upload details when extraction fails", async () => {
        const result = await expandArchiveUploadFiles([new File(["broken"], "broken.zip")], async () => {
            throw new Error("invalid archive");
        });

        expect(result).toEqual({
            ok: false,
            kind: "unsupported",
            fileName: "broken.zip",
            message: "Archive could not be extracted",
        });
    });

    test("counts non-archive files toward maxFiles", async () => {
        const result = await expandArchiveUploadFiles(
            [new File(["one"], "one.txt"), new File(["two"], "two.txt")],
            extractArchiveUploadFile,
            { maxFiles: 1, maxBytes: 1024 }
        );

        expect(result).toEqual({
            ok: false,
            kind: "limit",
            fileName: "two.txt",
            message: "Upload expands to too many files",
        });
    });
});

describe("extractArchiveUploadFile", () => {
    bsdtarTest("extracts zip entries and ignores archive folders", async () => {
        const archive = new File(
            [
                storedZip([
                    { path: "nested/alpha.txt", content: "alpha" },
                    { path: "beta.txt", content: "beta" },
                ]),
            ],
            "documents.zip",
            { type: "application/zip" }
        );

        const files = await extractArchiveUploadFile(archive);

        expect(files.map((file) => file.name)).toEqual(["beta.txt", "alpha.txt"]);
        await expect(files.find((file) => file.name === "alpha.txt")!.text()).resolves.toBe("alpha");
        await expect(files.find((file) => file.name === "beta.txt")!.text()).resolves.toBe("beta");
    });

    gzipTest("decompresses single-file gzip uploads", async () => {
        const archive = new File([gzipSync(encoder.encode("hello"))], "notes.txt.gz", { type: "application/gzip" });

        const files = await extractArchiveUploadFile(archive);

        expect(files.map((file) => file.name)).toEqual(["notes.txt"]);
        await expect(files[0]!.text()).resolves.toBe("hello");
    });

    bsdtarTest("counts zip entries toward maxFiles", async () => {
        const archive = new File(
            [
                storedZip([
                    { path: "alpha.txt", content: "alpha" },
                    { path: "beta.txt", content: "beta" },
                ]),
            ],
            "documents.zip",
            { type: "application/zip" }
        );

        const result = await expandArchiveUploadFiles([archive], extractArchiveUploadFile, {
            maxFiles: 1,
            maxBytes: 1024,
        });

        expect(result).toEqual({
            ok: false,
            kind: "limit",
            fileName: "documents.zip",
            message: "Upload expands to too many files",
        });
    });

    gzipTest("counts single-file gzip output toward maxBytes", async () => {
        const archive = new File([gzipSync(encoder.encode("hello"))], "notes.txt.gz", { type: "application/gzip" });

        const result = await expandArchiveUploadFiles([archive], extractArchiveUploadFile, {
            maxFiles: 1,
            maxBytes: 4,
        });

        expect(result).toEqual({
            ok: false,
            kind: "limit",
            fileName: "notes.txt.gz",
            message: "Upload expands to too much data",
        });
    });
});

function storedZip(entries: Array<{ path: string; content: string }>): Uint8Array<ArrayBuffer> {
    const local: Uint8Array<ArrayBuffer>[] = [];
    const central: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.path);
        const content = encoder.encode(entry.content);
        const checksum = crc32(content);
        const localHeader = concatBytes([
            uint32(0x04034b50),
            uint16(20),
            uint16(0),
            uint16(0),
            uint16(0),
            uint16(0),
            uint32(checksum),
            uint32(content.length),
            uint32(content.length),
            uint16(name.length),
            uint16(0),
            name,
        ]);
        local.push(localHeader, content);
        central.push(
            concatBytes([
                uint32(0x02014b50),
                uint16(20),
                uint16(20),
                uint16(0),
                uint16(0),
                uint16(0),
                uint16(0),
                uint32(checksum),
                uint32(content.length),
                uint32(content.length),
                uint16(name.length),
                uint16(0),
                uint16(0),
                uint16(0),
                uint16(0),
                uint32(0),
                uint32(offset),
                name,
            ])
        );
        offset += localHeader.length + content.length;
    }

    const directory = concatBytes(central);
    return concatBytes([
        ...local,
        directory,
        uint32(0x06054b50),
        uint16(0),
        uint16(0),
        uint16(entries.length),
        uint16(entries.length),
        uint32(directory.length),
        uint32(offset),
        uint16(0),
    ]);
}

function crc32(content: Uint8Array): number {
    let checksum = 0xffffffff;
    for (const byte of content) {
        checksum = crcTable[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
    }
    return (checksum ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
}

function uint32(value: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}
