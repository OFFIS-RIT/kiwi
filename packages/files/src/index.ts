import { lookup } from "mime-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { v7 as uuid } from "uuid";
import { S3Client } from "bun";

export type StoredFile = {
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

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
    operation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
}) {
    constructor(operation: string, options?: { cause?: unknown }) {
        super(options?.cause === undefined ? { operation } : { operation, cause: options.cause });
    }

    override get message(): string {
        return `File storage operation failed: ${this.operation}`;
    }
}

type FileBody = File | Blob | Uint8Array | string;

export type FileStorageGetFile = {
    (key: string, bucket: string): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError>;
    (
        key: string,
        bucket: string,
        type: "bytes"
    ): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError>;
    (key: string, bucket: string, type: "text"): Effect.Effect<{ type: "text"; content: string } | null, StorageError>;
    <T = unknown>(
        key: string,
        bucket: string,
        type: "json"
    ): Effect.Effect<{ type: "json"; content: T } | null, StorageError>;
};

export type FileStorageService = {
    readonly putFile: (
        name: string,
        file: FileBody,
        path: string,
        bucket: string
    ) => Effect.Effect<StoredFile, StorageError>;
    readonly putGraphFile: (
        graphId: string,
        fileId: string,
        name: string,
        file: FileBody,
        bucket: string
    ) => Effect.Effect<StoredFile, StorageError>;
    readonly putNamedFile: (
        name: string,
        file: FileBody,
        path: string,
        bucket: string
    ) => Effect.Effect<StoredFile, StorageError>;
    readonly getFile: FileStorageGetFile;
    readonly getFileStream: (
        key: string,
        bucket: string,
        range?: { start: number; end: number },
        metadata?: StoredFileMetadata
    ) => Effect.Effect<StoredFileStream | null, StorageError>;
    readonly getFileArrayBuffer: (
        key: string,
        bucket: string,
        range?: { start: number; end: number }
    ) => Effect.Effect<ArrayBuffer | null, StorageError>;
    readonly getFileMetadata: (key: string, bucket: string) => Effect.Effect<StoredFileMetadata | null, StorageError>;
    readonly deleteFile: (key: string, bucket: string) => Effect.Effect<boolean, StorageError>;
    readonly listFiles: (path: string, bucket: string) => Effect.Effect<string[], StorageError>;
    readonly getPresignedDownloadUrl: (
        key: string,
        bucket: string,
        expiresIn?: number
    ) => Effect.Effect<string, StorageError>;
};

export class FileStorage extends Context.Service<FileStorage, FileStorageService>()("@kiwi/files/FileStorage") {}

function tryStorage<T>(operation: string, thunk: () => PromiseLike<T>): Effect.Effect<T, StorageError> {
    return Effect.tryPromise({
        try: thunk,
        catch: (cause) => new StorageError(operation, { cause }),
    });
}

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

function writeFile(key: string, file: FileBody, bucket: string): Effect.Effect<StoredFile, StorageError> {
    return tryStorage("write", async () => {
        const client = getClient(bucket);
        const s3File = client.file(key);

        await s3File.write(file);

        return {
            key,
            type: getFileType(key),
        };
    });
}

function putFileImpl(
    name: string,
    file: FileBody,
    path: string,
    bucket: string
): Effect.Effect<StoredFile, StorageError> {
    const extension = name.split(".").pop() || "";
    const key = uuid();
    const filename = extension === "" ? key : `${key}.${extension}`;

    return writeFile(joinPath(path, filename), file, bucket);
}

function putGraphFileImpl(
    graphId: string,
    fileId: string,
    name: string,
    file: FileBody,
    bucket: string
): Effect.Effect<StoredFile, StorageError> {
    return writeFile(getGraphFileKey(graphId, fileId, name), file, bucket);
}

function putNamedFileImpl(
    name: string,
    file: FileBody,
    path: string,
    bucket: string
): Effect.Effect<StoredFile, StorageError> {
    return writeFile(joinPath(path, name), file, bucket);
}

function getFileImpl(
    key: string,
    bucket: string
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError>;
function getFileImpl(
    key: string,
    bucket: string,
    type: "bytes"
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError>;
function getFileImpl(
    key: string,
    bucket: string,
    type: "text"
): Effect.Effect<{ type: "text"; content: string } | null, StorageError>;
function getFileImpl<T = unknown>(
    key: string,
    bucket: string,
    type: "json"
): Effect.Effect<{ type: "json"; content: T } | null, StorageError>;
function getFileImpl(
    key: string,
    bucket: string,
    type: "bytes" | "text" | "json" = "bytes"
): Effect.Effect<{ type: "bytes" | "text" | "json"; content: unknown } | null, StorageError> {
    return tryStorage("read", async () => {
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

function getFileStreamImpl(
    key: string,
    bucket: string,
    range?: { start: number; end: number },
    metadata?: StoredFileMetadata
): Effect.Effect<StoredFileStream | null, StorageError> {
    return tryStorage("stream", async () => {
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

function getFileArrayBufferImpl(
    key: string,
    bucket: string,
    range?: { start: number; end: number }
): Effect.Effect<ArrayBuffer | null, StorageError> {
    return tryStorage("read bytes", async () => {
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

function getFileMetadataImpl(key: string, bucket: string): Effect.Effect<StoredFileMetadata | null, StorageError> {
    return tryStorage("metadata", async () => {
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

function deleteFileImpl(key: string, bucket: string): Effect.Effect<boolean, StorageError> {
    return tryStorage("delete", async () => {
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

function listFilesImpl(path: string, bucket: string): Effect.Effect<string[], StorageError> {
    return tryStorage("list", async () => {
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

function getPresignedDownloadUrlImpl(
    key: string,
    bucket: string,
    expiresIn = 3600
): Effect.Effect<string, StorageError> {
    return Effect.try({
        try: () => {
            const client = getClient(bucket);

            return client.presign(key, {
                method: "GET",
                expiresIn,
            });
        },
        catch: (cause) => new StorageError("presign", { cause }),
    });
}

const readFileImpl = getFileImpl as (
    key: string,
    bucket: string,
    type: "bytes" | "text" | "json"
) => Effect.Effect<{ type: "bytes" | "text" | "json"; content: unknown } | null, StorageError>;
const getFileLive: FileStorageGetFile = ((key: string, bucket: string, type: "bytes" | "text" | "json" = "bytes") =>
    readFileImpl(key, bucket, type)) as FileStorageGetFile;

export const FileStorageLive = Layer.succeed(FileStorage, {
    putFile: Effect.fn("FileStorage.putFile")(putFileImpl),
    putGraphFile: Effect.fn("FileStorage.putGraphFile")(putGraphFileImpl),
    putNamedFile: Effect.fn("FileStorage.putNamedFile")(putNamedFileImpl),
    getFile: getFileLive,
    getFileStream: Effect.fn("FileStorage.getFileStream")(getFileStreamImpl),
    getFileArrayBuffer: Effect.fn("FileStorage.getFileArrayBuffer")(getFileArrayBufferImpl),
    getFileMetadata: Effect.fn("FileStorage.getFileMetadata")(getFileMetadataImpl),
    deleteFile: Effect.fn("FileStorage.deleteFile")(deleteFileImpl),
    listFiles: Effect.fn("FileStorage.listFiles")(listFilesImpl),
    getPresignedDownloadUrl: Effect.fn("FileStorage.getPresignedDownloadUrl")(getPresignedDownloadUrlImpl),
} satisfies FileStorageService);

export function putFile(
    name: string,
    file: FileBody,
    path: string,
    bucket: string
): Effect.Effect<StoredFile, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.putFile(name, file, path, bucket));
}

export function putGraphFile(
    graphId: string,
    fileId: string,
    name: string,
    file: FileBody,
    bucket: string
): Effect.Effect<StoredFile, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.putGraphFile(graphId, fileId, name, file, bucket));
}

export function putNamedFile(
    name: string,
    file: FileBody,
    path: string,
    bucket: string
): Effect.Effect<StoredFile, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.putNamedFile(name, file, path, bucket));
}

export function getFile(
    key: string,
    bucket: string
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError, FileStorage>;
export function getFile(
    key: string,
    bucket: string,
    type: "bytes"
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError, FileStorage>;
export function getFile(
    key: string,
    bucket: string,
    type: "text"
): Effect.Effect<{ type: "text"; content: string } | null, StorageError, FileStorage>;
export function getFile<T = unknown>(
    key: string,
    bucket: string,
    type: "json"
): Effect.Effect<{ type: "json"; content: T } | null, StorageError, FileStorage>;
export function getFile(
    key: string,
    bucket: string,
    type: "bytes" | "text" | "json" = "bytes"
): Effect.Effect<{ type: "bytes" | "text" | "json"; content: unknown } | null, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.getFile(key, bucket, type as "bytes"));
}

export function getFileStream(
    key: string,
    bucket: string,
    range?: { start: number; end: number },
    metadata?: StoredFileMetadata
): Effect.Effect<StoredFileStream | null, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.getFileStream(key, bucket, range, metadata));
}

export function getFileArrayBuffer(
    key: string,
    bucket: string,
    range?: { start: number; end: number }
): Effect.Effect<ArrayBuffer | null, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.getFileArrayBuffer(key, bucket, range));
}

export function getFileMetadata(
    key: string,
    bucket: string
): Effect.Effect<StoredFileMetadata | null, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.getFileMetadata(key, bucket));
}

export function deleteFile(key: string, bucket: string): Effect.Effect<boolean, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.deleteFile(key, bucket));
}

export function listFiles(path: string, bucket: string): Effect.Effect<string[], StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.listFiles(path, bucket));
}

export function getPresignedDownloadUrl(
    key: string,
    bucket: string,
    expiresIn = 3600
): Effect.Effect<string, StorageError, FileStorage> {
    return FileStorage.use((storage) => storage.getPresignedDownloadUrl(key, bucket, expiresIn));
}
