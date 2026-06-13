import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export type ArchiveUploadLimits = { maxFiles: number; maxBytes: number };

export const DEFAULT_ARCHIVE_UPLOAD_LIMITS = {
    maxFiles: 500,
    maxBytes: 1024 * 1024 * 1024,
} satisfies ArchiveUploadLimits;

export const ARCHIVE_UPLOAD_TOOLS = ["bsdtar", "gzip", "bzip2", "xz", "zstd", "brotli"] as const;

type ExpansionResult =
    | { ok: true; files: File[] }
    | { ok: false; kind: "unsupported" | "limit"; fileName: string; message: string };

type Compression = {
    extensions: readonly string[];
    mimeTypes: readonly string[];
    command: string;
    args: (inputPath: string) => string[];
};

class MissingArchiveToolError extends Error {}

class ArchiveUploadLimitError extends Error {
    readonly isArchiveUploadLimitError = true;
}

const CONTAINER_EXTENSIONS = [
    ".tar.gz",
    ".tgz",
    ".tar.bz2",
    ".tbz2",
    ".tbz",
    ".tar.xz",
    ".txz",
    ".tar.zst",
    ".tzst",
    ".tar.lzma",
    ".tlz",
    ".tar.br",
    ".zip",
    ".rar",
    ".7z",
    ".tar",
] as const;

const COMPRESSIONS: readonly Compression[] = [
    {
        extensions: [".gz"],
        mimeTypes: ["application/gzip", "application/x-gzip"],
        command: "gzip",
        args: (inputPath) => ["-dc", inputPath],
    },
    {
        extensions: [".bz2"],
        mimeTypes: ["application/x-bzip2"],
        command: "bzip2",
        args: (inputPath) => ["-dc", inputPath],
    },
    {
        extensions: [".xz"],
        mimeTypes: ["application/x-xz"],
        command: "xz",
        args: (inputPath) => ["-dc", inputPath],
    },
    {
        extensions: [".zst"],
        mimeTypes: ["application/zstd", "application/x-zstd"],
        command: "zstd",
        args: (inputPath) => ["-dc", inputPath],
    },
    {
        extensions: [".lzma"],
        mimeTypes: ["application/x-lzma"],
        command: "xz",
        args: (inputPath) => ["--format=lzma", "-dc", inputPath],
    },
    {
        extensions: [".br"],
        mimeTypes: ["application/x-brotli"],
        command: "brotli",
        args: (inputPath) => ["-dc", inputPath],
    },
] as const;

const CONTAINER_MIME_TYPES: readonly string[] = [
    "application/zip",
    "application/x-zip-compressed",
    "application/vnd.rar",
    "application/x-rar-compressed",
    "application/x-7z-compressed",
    "application/x-tar",
];

export function isArchiveUploadFile(file: Pick<File, "name" | "type">): boolean {
    const name = file.name.trim().toLowerCase();
    return (
        CONTAINER_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
        CONTAINER_MIME_TYPES.includes(file.type.trim().toLowerCase()) ||
        getCompression(file) !== null
    );
}

function getCompression(file: Pick<File, "name" | "type">): Compression | null {
    const name = file.name.trim().toLowerCase();
    if (CONTAINER_EXTENSIONS.some((extension) => name.endsWith(extension))) {
        return null;
    }

    const mime = file.type.trim().toLowerCase();
    return (
        COMPRESSIONS.find(
            (compression) =>
                compression.extensions.some((extension) => name.endsWith(extension)) ||
                compression.mimeTypes.includes(mime)
        ) ?? null
    );
}

export async function expandArchiveUploadFiles(
    files: File[],
    extract = extractArchiveUploadFile,
    limits = DEFAULT_ARCHIVE_UPLOAD_LIMITS
): Promise<ExpansionResult> {
    const expanded: File[] = [];
    let totalFiles = 0;
    let totalBytes = 0;

    const countFile = (file: File, fileName: string): ExpansionResult | null => {
        if (totalFiles + 1 > limits.maxFiles) {
            return {
                ok: false,
                kind: "limit",
                fileName,
                message: "Upload expands to too many files",
            };
        }

        if (totalBytes + file.size > limits.maxBytes) {
            return {
                ok: false,
                kind: "limit",
                fileName,
                message: "Upload expands to too much data",
            };
        }

        totalFiles += 1;
        totalBytes += file.size;
        return null;
    };

    for (const file of files) {
        if (!isArchiveUploadFile(file)) {
            const limitFailure = countFile(file, file.name);
            if (limitFailure) {
                return limitFailure;
            }
            expanded.push(file);
            continue;
        }

        try {
            const extractedFiles = await extract(file, {
                maxFiles: limits.maxFiles - totalFiles,
                maxBytes: limits.maxBytes - totalBytes,
            });
            for (const extractedFile of extractedFiles) {
                const limitFailure = countFile(extractedFile, file.name);
                if (limitFailure) {
                    return limitFailure;
                }
                expanded.push(extractedFile);
            }
        } catch (error) {
            const limit = isArchiveUploadLimitError(error);
            return {
                ok: false,
                kind: limit ? "limit" : "unsupported",
                fileName: file.name,
                message: limit ? error.message : archiveErrorMessage(error),
            };
        }
    }

    return { ok: true, files: expanded };
}

export async function extractArchiveUploadFile(file: File, limits = DEFAULT_ARCHIVE_UPLOAD_LIMITS): Promise<File[]> {
    const tempDir = await mkdtemp(join(tmpdir(), "kiwi-archive-upload-"));

    try {
        const safeName = basename(file.name).replace(/\0/gu, "").trim();
        const inputPath = join(tempDir, safeName.length > 0 ? safeName : "archive");
        await writeBlobToPath(file, inputPath);

        const compression = getCompression(file);
        if (compression) {
            const content = await runTool(compression.command, compression.args(inputPath), {
                stdout: true,
                failure: "Compression extraction failed",
                maxBytes: limits.maxBytes,
            });
            if (limits.maxFiles < 1) {
                throw new ArchiveUploadLimitError("Upload expands to too many files");
            }
            return [new File([content], decompressedName(file.name, compression))];
        }

        const listing = await runTool("bsdtar", ["-tf", inputPath], {
            stdout: true,
            failure: "Archive listing failed",
        });
        const entries = listing
            .toString("utf8")
            .split("\n")
            .map((entry) => entry.trimEnd())
            .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
            .sort((left, right) => left.localeCompare(right));

        const extracted: File[] = [];
        let totalBytes = 0;
        const entryNames = archiveEntryNames(entries);

        for (const [index, entry] of entries.entries()) {
            if (extracted.length + 1 > limits.maxFiles) {
                throw new ArchiveUploadLimitError("Upload expands to too many files");
            }

            const content = await runTool("bsdtar", ["-xOf", inputPath, "--", entry], {
                stdout: true,
                failure: "Archive extraction failed",
                maxBytes: limits.maxBytes - totalBytes,
            });
            totalBytes += content.byteLength;
            extracted.push(new File([content], entryNames[index] ?? basename(entry)));
        }

        return extracted;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

async function writeBlobToPath(file: Blob, path: string): Promise<void> {
    const stream = file.stream() as unknown as NodeReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(stream), createWriteStream(path));
}

function archiveEntryNames(entries: readonly string[]): string[] {
    const basenameCounts = new Map<string, number>();
    for (const entry of entries) {
        const name = basename(entry);
        basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
    }

    const usedNames = new Set<string>();
    return entries.map((entry) => uniqueArchiveEntryName(entry, basenameCounts, usedNames));
}

function uniqueArchiveEntryName(
    entry: string,
    basenameCounts: ReadonlyMap<string, number>,
    usedNames: Set<string>
): string {
    const name = basename(entry);
    const candidate = (basenameCounts.get(name) ?? 0) > 1 ? flattenedArchiveEntryName(entry) : name;
    if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
    }

    const extension = extname(candidate);
    const stem = extension.length > 0 ? candidate.slice(0, -extension.length) : candidate;
    let counter = 2;
    while (usedNames.has(`${stem}-${counter}${extension}`)) {
        counter += 1;
    }

    const uniqueName = `${stem}-${counter}${extension}`;
    usedNames.add(uniqueName);
    return uniqueName;
}

function flattenedArchiveEntryName(entry: string): string {
    const segments = entry.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    return segments.length > 0 ? segments.join("__") : basename(entry);
}

export async function checkArchiveUploadTools(): Promise<{ ok: true } | { ok: false; missing: string[] }> {
    const missing: string[] = [];

    await Promise.all(
        ARCHIVE_UPLOAD_TOOLS.map(async (tool) => {
            if (!(await hasArchiveUploadTool(tool))) {
                missing.push(tool);
            }
        })
    );

    missing.sort((left, right) => left.localeCompare(right));
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

function hasArchiveUploadTool(tool: string): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn(tool, ["--version"], {
            stdio: "ignore",
        });
        let settled = false;

        const finish = (available: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(available);
        };

        child.on("error", () => finish(false));
        child.on("close", (code) => finish(code === 0));
    });
}

type ToolOptions = { stdout: true; failure: string; maxBytes?: number } | { stdout?: false; failure: string };

function runTool(
    command: string,
    args: string[],
    options: { stdout: true; failure: string; maxBytes?: number }
): Promise<Buffer<ArrayBuffer>>;
function runTool(command: string, args: string[], options: { stdout?: false; failure: string }): Promise<void>;
function runTool(command: string, args: string[], options: ToolOptions): Promise<Buffer<ArrayBuffer> | void> {
    return new Promise<Buffer<ArrayBuffer> | void>((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", options.stdout ? "pipe" : "ignore", "pipe"],
        });
        const chunks: Buffer<ArrayBuffer>[] | null = options.stdout ? [] : null;
        let output = "";
        let bytes = 0;
        let settled = false;

        const finish = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            callback();
        };

        child.stdout?.on("data", (chunk: Buffer<ArrayBuffer>) => {
            if (!chunks) {
                return;
            }

            bytes += chunk.byteLength;
            if (options.stdout && options.maxBytes !== undefined && bytes > options.maxBytes) {
                finish(() => {
                    child.kill();
                    reject(new ArchiveUploadLimitError("Upload expands to too much data"));
                });
                return;
            }

            chunks.push(chunk);
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => {
            output += chunk;
        });
        child.on("error", (error) => {
            finish(() => {
                if (isMissingCommand(error)) {
                    reject(new MissingArchiveToolError("Archive extraction is not available"));
                    return;
                }

                reject(error);
            });
        });
        child.on("close", (code) => {
            finish(() => {
                if (code === 0) {
                    resolve(chunks ? Buffer.concat(chunks) : undefined);
                    return;
                }

                reject(new Error(output.trim() || `${options.failure} with exit code ${code}`));
            });
        });
    });
}

function decompressedName(fileName: string, compression: Compression): string {
    const name = basename(fileName).replace(/\0/gu, "").trim();
    const lowerName = name.toLowerCase();
    for (const extension of compression.extensions) {
        if (lowerName.endsWith(extension)) {
            const strippedName = name.slice(0, -extension.length).trim();
            return strippedName.length > 0 ? strippedName : "file";
        }
    }

    return name.length > 0 ? name : "file";
}

function archiveErrorMessage(error: unknown): string {
    if (error instanceof MissingArchiveToolError) {
        return "Archive extraction is not available";
    }

    const message = error instanceof Error ? error.message : String(error);
    if (/password|passphrase|encrypted/iu.test(message)) {
        return "Password-protected archives are not supported";
    }

    return "Archive could not be extracted";
}

function isArchiveUploadLimitError(error: unknown): error is ArchiveUploadLimitError {
    return error instanceof ArchiveUploadLimitError;
}

function isMissingCommand(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
