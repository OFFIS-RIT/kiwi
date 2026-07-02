import { lookup } from "mime-types";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { v7 as uuid } from "uuid";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput, HeadObjectCommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

export type FileStorageConfig = {
    readonly region: string;
    readonly endpoint: string;
    readonly accessKeyId: Redacted.Redacted<string>;
    readonly secretAccessKey: Redacted.Redacted<string>;
};

export const FileStorageConfig: Effect.Effect<FileStorageConfig, Config.ConfigError> = Effect.gen(function* () {
    const accessKeyId = yield* Config.redacted("S3_ACCESS_KEY_ID").pipe(
        Config.orElse(() => Config.redacted("S3_ACCESS_KEY"))
    );

    return {
        region: yield* Config.string("S3_REGION"),
        endpoint: yield* Config.string("S3_ENDPOINT"),
        accessKeyId,
        secretAccessKey: yield* Config.redacted("S3_SECRET_ACCESS_KEY"),
    } satisfies FileStorageConfig;
});

function createS3Client(config: FileStorageConfig): S3Client {
    return new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.endpoint ? true : undefined,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        credentials: {
            accessKeyId: Redacted.value(config.accessKeyId),
            secretAccessKey: Redacted.value(config.secretAccessKey),
        },
    });
}

function isS3NotFound(cause: unknown): boolean {
    if (!cause || typeof cause !== "object") {
        return false;
    }

    const error = cause as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    return (
        error.name === "NoSuchKey" ||
        error.name === "NotFound" ||
        error.Code === "NoSuchKey" ||
        error.$metadata?.httpStatusCode === 404
    );
}

async function getObject(
    client: S3Client,
    key: string,
    bucket: string,
    range?: { start: number; end: number }
): Promise<GetObjectCommandOutput | null> {
    try {
        return await client.send(
            new GetObjectCommand({
                Bucket: bucket,
                Key: key,
                Range: range ? `bytes=${range.start}-${range.end}` : undefined,
            })
        );
    } catch (cause) {
        if (isS3NotFound(cause)) {
            return null;
        }

        throw cause;
    }
}

async function headObject(client: S3Client, key: string, bucket: string): Promise<HeadObjectCommandOutput | null> {
    try {
        return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (cause) {
        if (isS3NotFound(cause)) {
            return null;
        }

        throw cause;
    }
}

function requireBody(
    body: GetObjectCommandOutput["Body"],
    operation: string
): NonNullable<GetObjectCommandOutput["Body"]> {
    if (!body) {
        throw new Error(`S3 returned no body for ${operation}`);
    }

    return body;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);

    return buffer;
}

async function toS3Body(file: FileBody): Promise<string | Uint8Array> {
    if (typeof file === "string" || file instanceof Uint8Array) {
        return file;
    }

    return new Uint8Array(await file.arrayBuffer());
}

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

function writeFile(client: S3Client, key: string, file: FileBody, bucket: string): Effect.Effect<StoredFile, StorageError> {
    return tryStorage("write", async () => {
        await client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: await toS3Body(file),
                ContentType: file instanceof Blob && file.type ? file.type : getFileType(key),
            })
        );

        return {
            key,
            type: getFileType(key),
        };
    });
}

function putFileImpl(
    client: S3Client,
    name: string,
    file: FileBody,
    path: string,
    bucket: string
): Effect.Effect<StoredFile, StorageError> {
    const extension = name.split(".").pop() || "";
    const key = uuid();
    const filename = extension === "" ? key : `${key}.${extension}`;

    return writeFile(client, joinPath(path, filename), file, bucket);
}

function putGraphFileImpl(
    client: S3Client,
    graphId: string,
    fileId: string,
    name: string,
    file: FileBody,
    bucket: string
): Effect.Effect<StoredFile, StorageError> {
    return writeFile(client, getGraphFileKey(graphId, fileId, name), file, bucket);
}

function putNamedFileImpl(
    client: S3Client,
    name: string,
    file: FileBody,
    path: string,
    bucket: string
): Effect.Effect<StoredFile, StorageError> {
    return writeFile(client, joinPath(path, name), file, bucket);
}

function getFileImpl(
    client: S3Client,
    key: string,
    bucket: string
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError>;
function getFileImpl(
    client: S3Client,
    key: string,
    bucket: string,
    type: "bytes"
): Effect.Effect<{ type: "bytes"; content: ArrayBuffer } | null, StorageError>;
function getFileImpl(
    client: S3Client,
    key: string,
    bucket: string,
    type: "text"
): Effect.Effect<{ type: "text"; content: string } | null, StorageError>;
function getFileImpl<T = unknown>(
    client: S3Client,
    key: string,
    bucket: string,
    type: "json"
): Effect.Effect<{ type: "json"; content: T } | null, StorageError>;
function getFileImpl(
    client: S3Client,
    key: string,
    bucket: string,
    type: "bytes" | "text" | "json" = "bytes"
): Effect.Effect<{ type: "bytes" | "text" | "json"; content: unknown } | null, StorageError> {
    return tryStorage("read", async () => {
        const response = await getObject(client, key, bucket);
        if (!response) {
            return null;
        }

        const body = requireBody(response.Body, "read");
        switch (type) {
            case "text": {
                const text = await body.transformToString();
                return { type, content: text };
            }
            case "json": {
                const text = await body.transformToString();
                return { type, content: JSON.parse(text) };
            }
            case "bytes": {
                const bytes = await body.transformToByteArray();
                return { type, content: toArrayBuffer(bytes) };
            }
        }
    });
}

function getFileStreamImpl(
    client: S3Client,
    key: string,
    bucket: string,
    range?: { start: number; end: number },
    metadata?: StoredFileMetadata
): Effect.Effect<StoredFileStream | null, StorageError> {
    return tryStorage("stream", async () => {
        const response = await getObject(client, key, bucket, range);
        if (!response) {
            return null;
        }

        const body = requireBody(response.Body, "stream");
        const size = range ? range.end - range.start + 1 : (metadata?.size ?? response.ContentLength ?? 0);

        return {
            content: body.transformToWebStream() as ReadableStream<Uint8Array>,
            size,
            type: metadata?.type ?? response.ContentType ?? getFileType(key),
            lastModified: metadata?.lastModified ?? response.LastModified ?? null,
        };
    });
}

function getFileArrayBufferImpl(
    client: S3Client,
    key: string,
    bucket: string,
    range?: { start: number; end: number }
): Effect.Effect<ArrayBuffer | null, StorageError> {
    return tryStorage("read bytes", async () => {
        const response = await getObject(client, key, bucket, range);
        if (!response) {
            return null;
        }

        const bytes = await requireBody(response.Body, "read bytes").transformToByteArray();

        return toArrayBuffer(bytes);
    });
}

function getFileMetadataImpl(
    client: S3Client,
    key: string,
    bucket: string
): Effect.Effect<StoredFileMetadata | null, StorageError> {
    return tryStorage("metadata", async () => {
        const response = await headObject(client, key, bucket);
        if (!response) {
            return null;
        }

        return {
            size: response.ContentLength ?? 0,
            type: response.ContentType ?? getFileType(key),
            lastModified: response.LastModified ?? null,
        };
    });
}

function deleteFileImpl(client: S3Client, key: string, bucket: string): Effect.Effect<boolean, StorageError> {
    return tryStorage("delete", async () => {
        const response = await headObject(client, key, bucket);
        if (!response) {
            return false;
        }

        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

        return true;
    });
}

function listFilesImpl(client: S3Client, path: string, bucket: string): Effect.Effect<string[], StorageError> {
    return tryStorage("list", async () => {
        const trimmedPath = path.replace(/^\/+/u, "").replace(/\/+$/u, "");
        const prefix = trimmedPath === "" ? "" : `${trimmedPath}/`;
        const keys = new Set<string>();
        let continuationToken: string | undefined;

        while (true) {
            const response = await client.send(
                new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                })
            );

            for (const entry of response.Contents ?? []) {
                if (entry.Key) {
                    keys.add(entry.Key);
                }
            }

            if (!response.IsTruncated || !response.NextContinuationToken) {
                break;
            }

            continuationToken = response.NextContinuationToken;
        }

        return [...keys];
    });
}

function getPresignedDownloadUrlImpl(
    client: S3Client,
    key: string,
    bucket: string,
    expiresIn = 3600
): Effect.Effect<string, StorageError> {
    return tryStorage("presign", async () =>
        getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn })
    );
}

function makeFileStorageService(client: S3Client): FileStorageService {
    const readFileImpl = getFileImpl as (
        client: S3Client,
        key: string,
        bucket: string,
        type: "bytes" | "text" | "json"
    ) => Effect.Effect<{ type: "bytes" | "text" | "json"; content: unknown } | null, StorageError>;
    const getFileLive: FileStorageGetFile = ((
        key: string,
        bucket: string,
        type: "bytes" | "text" | "json" = "bytes"
    ) => readFileImpl(client, key, bucket, type)) as FileStorageGetFile;

    return {
        putFile: Effect.fn("FileStorage.putFile")((name, file, path, bucket) =>
            putFileImpl(client, name, file, path, bucket)
        ),
        putGraphFile: Effect.fn("FileStorage.putGraphFile")((graphId, fileId, name, file, bucket) =>
            putGraphFileImpl(client, graphId, fileId, name, file, bucket)
        ),
        putNamedFile: Effect.fn("FileStorage.putNamedFile")((name, file, path, bucket) =>
            putNamedFileImpl(client, name, file, path, bucket)
        ),
        getFile: getFileLive,
        getFileStream: Effect.fn("FileStorage.getFileStream")((key, bucket, range, metadata) =>
            getFileStreamImpl(client, key, bucket, range, metadata)
        ),
        getFileArrayBuffer: Effect.fn("FileStorage.getFileArrayBuffer")((key, bucket, range) =>
            getFileArrayBufferImpl(client, key, bucket, range)
        ),
        getFileMetadata: Effect.fn("FileStorage.getFileMetadata")((key, bucket) =>
            getFileMetadataImpl(client, key, bucket)
        ),
        deleteFile: Effect.fn("FileStorage.deleteFile")((key, bucket) => deleteFileImpl(client, key, bucket)),
        listFiles: Effect.fn("FileStorage.listFiles")((path, bucket) => listFilesImpl(client, path, bucket)),
        getPresignedDownloadUrl: Effect.fn("FileStorage.getPresignedDownloadUrl")((key, bucket, expiresIn) =>
            getPresignedDownloadUrlImpl(client, key, bucket, expiresIn)
        ),
    } satisfies FileStorageService;
}

export const FileStorageLive = Layer.effect(
    FileStorage,
    Effect.map(FileStorageConfig, (config) => makeFileStorageService(createS3Client(config)))
).pipe(Layer.orDie);

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
