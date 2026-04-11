import { lookup } from "mime-types";
import { v7 as uuid } from "uuid";
import { S3Client } from "bun";

type StoredFile = {
    key: string;
    type: string;
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

const normalizePrefix = (path: string) => {
    const normalizedPath = path.replace(/^\/+/u, "").replace(/\/+$/u, "");

    return normalizedPath === "" ? "" : `${normalizedPath}/`;
};

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
    const prefix = normalizePrefix(path);
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
