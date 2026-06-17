import { lookup } from "mime-types";
import * as Effect from "effect/Effect";
import { v7 as uuid } from "uuid";
import { S3Client } from "bun";

type StoredFile = {
    key: string;
    type: string;
};

export type StoredFileStream = {
    content: ReadableStream<Uint8Array>;
    size: number;
    type: string;
    lastModified: Date | null;
};

export type StoredFileMetadata = {
    size: number;
    type: string;
    lastModified: Date | null;
};

const getClient = (bucket: string) => {
    return new S3Client({
        region: process.env.S3_REGION as string,
        accessKeyId: (process.env.S3_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY) as string,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
        endpoint: process.env.S3_ENDPOINT,
        bucket,
    });
};

const getFileType = (name: string) => {
    const extension = name.split(".").pop() || "";
    return lookup(extension) || "application/octet-stream";
};

const joinPath = (path: string, name: string) => {
    const normalizedPath = path.replace(/\/+$/u, "");
    const normalizedName = name.replace(/^\/+/u, "");

    return normalizedPath === "" ? normalizedName : `${normalizedPath}/${normalizedName}`;
};

const LEGACY_WORKFLOW_STORAGE_VERSION = "v1";

function getFileExtension(name: string): string {
    const extension = name.split(".").pop()?.trim().toLowerCase() ?? "";
    return extension && extension !== name.toLowerCase() ? extension : "";
}

export function getGraphFileKey(graphId: string, fileId: string, name: string): string {
    const extension = getFileExtension(name);
    const storedName = extension === "" ? fileId : `${fileId}.${extension}`;

    return joinPath(`graphs/${graphId}`, storedName);
}

export function getDerivedFilePrefix(fileKey: string, fileId: string): string {
    return `${fileKey.replace(/\/+$/u, "")}/${fileId}`;
}

export function getDerivedImagePrefix(fileKey: string, fileId: string): string {
    return `${getDerivedFilePrefix(fileKey, fileId)}/images`;
}

export function getDerivedSourceKey(fileKey: string, fileId: string): string {
    return `${getDerivedFilePrefix(fileKey, fileId)}/source.txt`;
}

export function getProcessingArtifactPrefix(fileKey: string, fileId: string): string {
    return `${getDerivedFilePrefix(fileKey, fileId)}/derived`;
}

export const PDF_PREVIEW_SCALE = 1.5;
const PDF_PREVIEW_VERSION = `v1/scale-${PDF_PREVIEW_SCALE}`;

export function getDerivedPdfPreviewPrefix(fileKey: string, fileId: string): string {
    return `${getDerivedFilePrefix(fileKey, fileId)}/pdf-preview/${PDF_PREVIEW_VERSION}`;
}

export function getGraphFileArtifactPaths(input: { graphId: string; fileId: string; fileKey: string }) {
    const derivedPrefix = getDerivedFilePrefix(input.fileKey, input.fileId);
    const processingPrefix = getProcessingArtifactPrefix(input.fileKey, input.fileId);

    return {
        derivedPrefix,
        derivedImagePrefix: getDerivedImagePrefix(input.fileKey, input.fileId),
        derivedSourceKey: getDerivedSourceKey(input.fileKey, input.fileId),
        derivedPdfPreviewPrefix: getDerivedPdfPreviewPrefix(input.fileKey, input.fileId),
        processingPrefix,
        cleanupPrefixes: [
            derivedPrefix,
            `graphs/${input.graphId}/derived/${input.fileId}`,
            `graphs/${input.graphId}/workflows/${LEGACY_WORKFLOW_STORAGE_VERSION}/${input.fileId}`,
        ],
    };
}

function writeFile(key: string, file: File | Blob | Uint8Array | string, bucket: string): Effect.Effect<StoredFile, unknown> {
    return Effect.tryPromise(async () => {
        const client = getClient(bucket);
        const s3File = client.file(key);

        await s3File.write(file);

        return {
            key,
            type: getFileType(key),
        };
    });
}

export function putFile(name: string, file: File | Blob | Uint8Array | string, path: string, bucket: string): Effect.Effect<StoredFile, unknown> {
    const extension = name.split(".").pop() || "";
    const key = uuid();
    const filename = extension === "" ? key : `${key}.${extension}`;

    return writeFile(joinPath(path, filename), file, bucket);
}

export function putGraphFile(
    graphId: string,
    fileId: string,
    name: string,
    file: File | Blob | Uint8Array | string,
    bucket: string
): Effect.Effect<StoredFile, unknown> {
    return writeFile(getGraphFileKey(graphId, fileId, name), file, bucket);
}

export function putNamedFile(name: string, file: File | Blob | Uint8Array | string, path: string, bucket: string): Effect.Effect<StoredFile, unknown> {
    return writeFile(joinPath(path, name), file, bucket);
}

export function getFile(
    key: string,
    bucket: string
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, unknown>;
export function getFile(
    key: string,
    bucket: string,
    type: "bytes"
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, unknown>;
export function getFile(
    key: string,
    bucket: string,
    type: "text"
): Effect.Effect<{ type: "text"; content: string } | null, unknown>;
export function getFile<T = unknown>(
    key: string,
    bucket: string,
    type: "json"
): Effect.Effect<{ type: "json"; content: T } | null, unknown>;
export function getFile(
    key: string,
    bucket: string,
    type: "bytes" | "text" | "json" = "bytes"
): Effect.Effect<{ type: "bytes" | "text" | "json"; content: unknown } | null, unknown> {
    return Effect.tryPromise(async () => {
        const client = getClient(bucket);
        const s3File = client.file(key);

        const exists = await s3File.exists();
        if (!exists) {
            return null;
        }

        switch (type) {
            case "text": {
                const text = await s3File.text();
                return { type, content: text };
            }
            case "json": {
                const json = await s3File.json();
                return { type, content: json };
            }
            case "bytes": {
                const bytes = await s3File.bytes();
                return { type, content: bytes };
            }
        }
    });
}

export function getFileStream(
    key: string,
    bucket: string,
    range?: { start: number; end: number },
    metadata?: StoredFileMetadata
): Effect.Effect<StoredFileStream | null, unknown> {
    return Effect.tryPromise(async () => {
        const client = getClient(bucket);
        const s3File = client.file(key);

        let fileMetadata = metadata;
        if (!fileMetadata) {
            const exists = await s3File.exists();
            if (!exists) {
                return null;
            }

            const stat = await s3File.stat();
            fileMetadata = {
                size: stat.size,
                type: s3File.type || getFileType(key),
                lastModified: stat.lastModified ?? null,
            };
        }

        const file = range ? s3File.slice(range.start, range.end + 1) : s3File;

        return {
            content: file.stream(),
            size: range ? range.end - range.start + 1 : fileMetadata.size,
            type: fileMetadata.type,
            lastModified: fileMetadata.lastModified,
        };
    });
}

export function getFileArrayBuffer(
    key: string,
    bucket: string,
    range?: { start: number; end: number }
): Effect.Effect<ArrayBuffer | null, unknown> {
    return Effect.tryPromise(async () => {
        const client = getClient(bucket);
        const s3File = client.file(key);

        const exists = await s3File.exists();
        if (!exists) {
            return null;
        }

        const file = range ? s3File.slice(range.start, range.end + 1) : s3File;
        const bytes = await file.bytes();
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);

        return buffer;
    });
}

export function getFileMetadata(key: string, bucket: string): Effect.Effect<StoredFileMetadata | null, unknown> {
    return Effect.tryPromise(async () => {
        const client = getClient(bucket);
        const s3File = client.file(key);

        const exists = await s3File.exists();
        if (!exists) {
            return null;
        }

        const stat = await s3File.stat();

        return {
            size: stat.size,
            type: s3File.type || getFileType(key),
            lastModified: stat.lastModified ?? null,
        };
    });
}

export function deleteFile(key: string, bucket: string): Effect.Effect<boolean, unknown> {
    return Effect.tryPromise(async () => {
        const client = getClient(bucket);
        const s3File = client.file(key);

        const exists = await s3File.exists();
        if (!exists) {
            return false;
        }

        await s3File.delete();

        return true;
    });
}

export function listFiles(path: string, bucket: string): Effect.Effect<string[], unknown> {
    return Effect.tryPromise(async () => {
        const client = getClient(bucket);
        const trimmedPath = path.replace(/^\/+/u, "").replace(/\/+$/u, "");
        const prefix = trimmedPath === "" ? "" : `${trimmedPath}/`;
        const keys = new Set<string>();
        let startAfter: string | undefined;

        while (true) {
            const response = await client.list({
                prefix,
                startAfter,
            });

            for (const entry of response.contents ?? []) {
                keys.add(entry.key);
            }

            if (!response.isTruncated || (response.contents?.length ?? 0) === 0) {
                break;
            }

            const lastEntry = response.contents?.[response.contents.length - 1];
            startAfter = lastEntry?.key;
            if (!startAfter) {
                break;
            }
        }

        return [...keys];
    });
}

export function getPresignedDownloadUrl(
    key: string,
    bucket: string,
    expiresIn = 3600
): Effect.Effect<string, unknown> {
    return Effect.sync(() => {
        const client = getClient(bucket);

        return client.presign(key, {
            method: "GET",
            expiresIn,
        });
    });
}
