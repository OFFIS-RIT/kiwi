import { lookup } from "mime-types";
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

export function getDerivedFilePrefix(graphId: string, fileId: string): string {
    return `graphs/${graphId}/derived/${fileId}`;
}

export function getDerivedImagePrefix(graphId: string, fileId: string): string {
    return `${getDerivedFilePrefix(graphId, fileId)}/images`;
}

export function getDerivedSourceKey(graphId: string, fileId: string): string {
    return `${getDerivedFilePrefix(graphId, fileId)}/source.txt`;
}

export const PDF_PREVIEW_SCALE = 1.5;
const PDF_PREVIEW_VERSION = `v1/scale-${PDF_PREVIEW_SCALE}`;

export function getDerivedPdfPreviewPrefix(graphId: string, fileId: string): string {
    return `${getDerivedFilePrefix(graphId, fileId)}/pdf-preview/${PDF_PREVIEW_VERSION}`;
}

async function writeFile(key: string, file: File | Blob | Uint8Array | string, bucket: string): Promise<StoredFile> {
    const client = getClient(bucket);
    const s3File = client.file(key);

    await s3File.write(file);

    return {
        key,
        type: getFileType(key),
    };
}

export async function putFile(name: string, file: File | Blob | Uint8Array | string, path: string, bucket: string) {
    const extension = name.split(".").pop() || "";
    const key = uuid();
    const filename = extension === "" ? key : `${key}.${extension}`;

    return writeFile(joinPath(path, filename), file, bucket);
}

export async function putNamedFile(
    name: string,
    file: File | Blob | Uint8Array | string,
    path: string,
    bucket: string
) {
    return writeFile(joinPath(path, name), file, bucket);
}

export async function getFile(key: string, bucket: string): Promise<{ type: "bytes"; content: ArrayBuffer } | null>;
export async function getFile(
    key: string,
    bucket: string,
    type: "bytes"
): Promise<{ type: "bytes"; content: ArrayBuffer } | null>;
export async function getFile(
    key: string,
    bucket: string,
    type: "text"
): Promise<{ type: "text"; content: string } | null>;
export async function getFile<T = unknown>(
    key: string,
    bucket: string,
    type: "json"
): Promise<{ type: "json"; content: T } | null>;
export async function getFile(
    key: string,
    bucket: string,
    type: "bytes" | "text" | "json" = "bytes"
): Promise<{ type: "bytes" | "text" | "json"; content: unknown } | null> {
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
}

export async function getFileStream(
    key: string,
    bucket: string,
    range?: { start: number; end: number },
    metadata?: StoredFileMetadata
): Promise<StoredFileStream | null> {
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
}

export async function getFileArrayBuffer(
    key: string,
    bucket: string,
    range?: { start: number; end: number }
): Promise<ArrayBuffer | null> {
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
}

export async function getFileMetadata(key: string, bucket: string): Promise<StoredFileMetadata | null> {
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
}

export async function deleteFile(key: string, bucket: string) {
    const client = getClient(bucket);
    const s3File = client.file(key);

    const exists = await s3File.exists();
    if (!exists) {
        return false;
    }

    await s3File.delete();

    return true;
}

export async function listFiles(path: string, bucket: string): Promise<string[]> {
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
}

export function getPresignedDownloadUrl(key: string, bucket: string, expiresIn = 3600) {
    const client = getClient(bucket);

    return client.presign(key, {
        method: "GET",
        expiresIn,
    });
}
