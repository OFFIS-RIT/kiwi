import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";

import type {
    ConnectorAdapter,
    ConnectorBinaryFile,
    ConnectorCredentialDescriptor,
    ConnectorCredentialPayloadData,
    ConnectorFileLocator,
    ConnectorResource,
    ConnectorResourceCapabilities,
    ConnectorResourceChange,
    ConnectorResourceChangeSet,
    ConnectorResourceChild,
    ConnectorResourceDelta,
    ConnectorResourceSnapshot,
    ConnectorResourceVersion,
    FetchLike,
    VersionedConnectorCredentialPayload,
} from "./types";
import { ConnectorProviderError } from "./types";

export const NEXTCLOUD_PROVIDER = "nextcloud";
export const NEXTCLOUD_CREDENTIAL_VERSION = "v1";

export const NEXTCLOUD_RESOURCE_CAPABILITIES: ConnectorResourceCapabilities = {
    versions: false,
    cursorSync: true,
    children: true,
    binaryFiles: true,
};

export type NextcloudConnectorCredentialData = {
    baseUrl: string;
};

export type NextcloudInstallationCredentialData = {
    username: string;
    appPassword: string;
    folderPath: string;
};

export type NextcloudConnectorCredentials = VersionedConnectorCredentialPayload<"app", typeof NEXTCLOUD_PROVIDER> & {
    data: NextcloudConnectorCredentialData;
};

export type NextcloudInstallationCredentials = VersionedConnectorCredentialPayload<
    "installation",
    typeof NEXTCLOUD_PROVIDER
> & {
    data: NextcloudInstallationCredentialData;
};

type NextcloudCredentialDescriptors = {
    app: ConnectorCredentialDescriptor<"app">;
    installation: ConnectorCredentialDescriptor<"installation">;
};

export const nextcloudCredentialDescriptors: NextcloudCredentialDescriptors = {
    app: {
        subject: "app",
        version: NEXTCLOUD_CREDENTIAL_VERSION,
        validate: isNextcloudConnectorCredentialData,
    },
    installation: {
        subject: "installation",
        version: NEXTCLOUD_CREDENTIAL_VERSION,
        validate: isNextcloudInstallationCredentialData,
    },
};

export type NextcloudAdapterOptions = NextcloudConnectorCredentialData &
    NextcloudInstallationCredentialData & {
        fetch?: FetchLike;
    };

type NextcloudClientContext = {
    baseUrl: string;
    username: string;
    appPassword: string;
    rootFolderPath: string;
    fetch: FetchLike;
};

type NextcloudDavEntry = {
    id: string;
    parentId: string | null;
    path: string;
    name: string;
    isFolder: boolean;
    webUrl: string;
    size?: number;
    mimeType?: string;
    contentType?: string;
    checksum?: string;
    etag?: string;
};

type NextcloudFileItem = NextcloudDavEntry & {
    isFolder: false;
    relativePath: string;
};

type NextcloudCursorFile = {
    id: string;
    path: string;
    etag?: string;
    checksum?: string;
    size?: number;
};

type NextcloudCursorState = {
    version: 1;
    files: NextcloudCursorFile[];
};

const NEXTCLOUD_CURSOR_PREFIX = "nextcloud:v1:";
const NEXTCLOUD_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:displayname />
    <d:getlastmodified />
    <d:getcontentlength />
    <d:getcontenttype />
    <d:resourcetype />
    <d:getetag />
    <oc:fileid />
    <oc:size />
    <oc:checksums />
  </d:prop>
</d:propfind>`;

export function normalizeNextcloudBaseUrl(value: string): string {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ConnectorProviderError("validation", "Nextcloud base URL must use HTTP or HTTPS");
    }

    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\/remote\.php\/(?:dav|webdav)$/u, "");
    if (parsed.pathname === "") {
        parsed.pathname = "/";
    }

    return parsed.toString().replace(/\/+$/u, "");
}

export function normalizeNextcloudFolderPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "/") {
        return "";
    }

    return trimmed
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("/");
}

export function publicNextcloudResourceId(folderPath: string): string {
    return normalizeNextcloudFolderPath(folderPath) || "/";
}

export function createNextcloudAdapter(options: NextcloudAdapterOptions): ConnectorAdapter {
    const context: NextcloudClientContext = {
        baseUrl: normalizeNextcloudBaseUrl(options.baseUrl),
        username: options.username,
        appPassword: options.appPassword,
        rootFolderPath: normalizeNextcloudFolderPath(options.folderPath),
        fetch: options.fetch ?? fetch,
    };

    return {
        provider: NEXTCLOUD_PROVIDER,
        resourceKind: "folder",
        capabilities: NEXTCLOUD_RESOURCE_CAPABILITIES,
        getResource: Effect.fn("NextcloudAdapter.getResource")(function* (resourceId: string) {
            return yield* getNextcloudResource(context, resourceId);
        }),
        listResources: Effect.fn("NextcloudAdapter.listResources")(function* () {
            return [yield* getNextcloudResource(context, context.rootFolderPath)];
        }),
        listResourceVersions: Effect.fn("NextcloudAdapter.listResourceVersions")(function* () {
            return [] satisfies ConnectorResourceVersion[];
        }),
        loadSnapshot: Effect.fn("NextcloudAdapter.loadSnapshot")(function* () {
            return yield* unsupportedVersionOperation<ConnectorResourceSnapshot>(
                "Nextcloud folders use cursor sync instead of snapshots"
            );
        }),
        compareVersions: Effect.fn("NextcloudAdapter.compareVersions")(function* () {
            return yield* unsupportedVersionOperation<ConnectorResourceDelta>(
                "Nextcloud folders use cursor sync instead of versions"
            );
        }),
        readFile: Effect.fn("NextcloudAdapter.readFile")(function* (locator: ConnectorFileLocator) {
            const file = yield* getNextcloudFile(context, locator);
            return new TextDecoder().decode(file.bytes);
        }),
        listChildren: Effect.fn("NextcloudAdapter.listChildren")(function* (parentId?: string) {
            const folderPath = parentId ? normalizeNextcloudFolderPath(parentId) : context.rootFolderPath;
            const entries = yield* listNextcloudFolderEntries(context, folderPath, parentId ? folderPath : null);
            return entries.map((entry) => mapNextcloudEntryToChild(context, entry));
        }),
        listChanges: Effect.fn("NextcloudAdapter.listChanges")(function* (resourceId: string, cursor?: string) {
            return yield* listNextcloudChanges(context, resourceId, cursor);
        }),
        openFile: Effect.fn("NextcloudAdapter.openFile")(function* (locator: ConnectorFileLocator) {
            return yield* getNextcloudFile(context, locator);
        }),
    };
}

export function isNextcloudConnectorCredentialData(data: ConnectorCredentialPayloadData): boolean {
    if (!hasNonEmptyString(data, "baseUrl")) {
        return false;
    }

    try {
        normalizeNextcloudBaseUrl(data.baseUrl as string);
        return true;
    } catch {
        return false;
    }
}

export function isNextcloudInstallationCredentialData(data: ConnectorCredentialPayloadData): boolean {
    return (
        hasNonEmptyString(data, "username") &&
        hasNonEmptyString(data, "appPassword") &&
        hasNonEmptyString(data, "folderPath")
    );
}

export function isNextcloudConnectorCredentials(value: unknown): value is NextcloudConnectorCredentials {
    return isVersionedNextcloudCredentials(value, "app") && isNextcloudConnectorCredentialData(value.data);
}

export function isNextcloudInstallationCredentials(value: unknown): value is NextcloudInstallationCredentials {
    return isVersionedNextcloudCredentials(value, "installation") && isNextcloudInstallationCredentialData(value.data);
}

function isVersionedNextcloudCredentials<Subject extends "app" | "installation">(
    value: unknown,
    subject: Subject
): value is VersionedConnectorCredentialPayload<Subject, typeof NEXTCLOUD_PROVIDER> {
    return (
        isObject(value) &&
        value.provider === NEXTCLOUD_PROVIDER &&
        value.subject === subject &&
        value.version === NEXTCLOUD_CREDENTIAL_VERSION &&
        isObject(value.data)
    );
}

function unsupportedVersionOperation<T>(message: string): Effect.Effect<T, ConnectorProviderError> {
    return Effect.fail(new ConnectorProviderError("validation", message));
}

function getNextcloudResource(
    context: NextcloudClientContext,
    resourceId: string
): Effect.Effect<ConnectorResource, ConnectorProviderError> {
    return Effect.gen(function* () {
        const path = normalizeNextcloudFolderPath(resourceId);
        const entry = yield* propfindSingle(context, path);
        return {
            provider: NEXTCLOUD_PROVIDER,
            kind: entry.isFolder ? "folder" : "file",
            id: publicNextcloudResourceId(path),
            displayName: entry.name || "Nextcloud files",
            webUrl: entry.webUrl || nextcloudWebUrl(context, path),
            private: true,
        };
    });
}

function listNextcloudChanges(
    context: NextcloudClientContext,
    resourceId: string,
    cursor?: string
): Effect.Effect<ConnectorResourceChangeSet, ConnectorProviderError> {
    return Effect.gen(function* () {
        const resourcePath = normalizeNextcloudFolderPath(resourceId);
        const resource = yield* propfindSingle(context, resourcePath);
        const files = resource.isFolder
            ? yield* walkNextcloudFiles(context, resourcePath)
            : [{ ...resource, isFolder: false as const, relativePath: resource.name }];
        const nextState = toCursorState(files);
        const nextCursor = encodeNextcloudCursor(nextState);
        const nextVersionId = `nextcloud:${hashString(nextCursor)}`;
        if (!cursor) {
            return {
                changes: files.map(nextcloudFileToAddedChange),
                cursor: nextCursor,
                versionId: nextVersionId,
                isInitial: true,
            };
        }

        const previousState = yield* decodeNextcloudCursor(cursor);
        const changes = diffNextcloudFiles(previousState.files, files);
        return { changes, cursor: nextCursor, versionId: nextVersionId, isInitial: false };
    });
}

function diffNextcloudFiles(
    previousFiles: readonly NextcloudCursorFile[],
    currentFiles: readonly NextcloudFileItem[]
): ConnectorResourceChange[] {
    const currentById = new Map(currentFiles.map((file) => [file.id, file]));
    const previousById = new Map(previousFiles.map((file) => [file.id, file]));
    const changes: ConnectorResourceChange[] = [];

    for (const current of currentFiles) {
        const previous = previousById.get(current.id);
        if (!previous) {
            changes.push(nextcloudFileToAddedChange(current));
            continue;
        }

        if (previous.path !== current.relativePath) {
            changes.push({
                ...nextcloudFileMetadata(current),
                status: "renamed",
                oldPath: previous.path,
                newPath: current.relativePath,
                providerItemId: current.id,
            } as ConnectorResourceChange);
            continue;
        }

        if (
            previous.etag !== current.etag ||
            previous.checksum !== current.checksum ||
            previous.size !== current.size
        ) {
            changes.push(nextcloudFileToModifiedChange(current));
        }
    }

    for (const previous of previousFiles) {
        if (!currentById.has(previous.id)) {
            changes.push({ status: "deleted", oldPath: previous.path, providerItemId: previous.id });
        }
    }

    return changes;
}

function nextcloudFileToAddedChange(file: NextcloudFileItem): ConnectorResourceChange {
    return {
        ...nextcloudFileMetadata(file),
        status: "added",
        newPath: file.relativePath,
        providerItemId: file.id,
    } as ConnectorResourceChange;
}

function nextcloudFileToModifiedChange(file: NextcloudFileItem): ConnectorResourceChange {
    return {
        ...nextcloudFileMetadata(file),
        status: "modified",
        newPath: file.relativePath,
        providerItemId: file.id,
    } as ConnectorResourceChange;
}

function nextcloudFileMetadata(file: NextcloudFileItem) {
    return {
        path: file.relativePath,
        parentProviderItemId: file.parentId,
        displayName: file.name,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.contentType ? { contentType: file.contentType } : {}),
        ...(file.size !== undefined ? { size: file.size } : {}),
        ...(file.checksum ? { checksum: file.checksum } : {}),
        ...(file.etag ? { etag: file.etag } : {}),
        webUrl: file.webUrl,
        contentAccessMode: "binary",
        processingKind: "document",
    };
}

function toCursorState(files: readonly NextcloudFileItem[]): NextcloudCursorState {
    return {
        version: 1,
        files: files.map((file) => ({
            id: file.id,
            path: file.relativePath,
            ...(file.etag ? { etag: file.etag } : {}),
            ...(file.checksum ? { checksum: file.checksum } : {}),
            ...(file.size !== undefined ? { size: file.size } : {}),
        })),
    };
}

function encodeNextcloudCursor(state: NextcloudCursorState): string {
    return `${NEXTCLOUD_CURSOR_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

function decodeNextcloudCursor(cursor: string): Effect.Effect<NextcloudCursorState, ConnectorProviderError> {
    return Effect.try({
        try: () => {
            if (!cursor.startsWith(NEXTCLOUD_CURSOR_PREFIX)) {
                throw new ConnectorProviderError("validation", "Nextcloud sync cursor is invalid");
            }
            const parsed = JSON.parse(
                Buffer.from(cursor.slice(NEXTCLOUD_CURSOR_PREFIX.length), "base64url").toString("utf8")
            ) as unknown;
            if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.files)) {
                throw new ConnectorProviderError("validation", "Nextcloud sync cursor is invalid");
            }
            const files: NextcloudCursorFile[] = [];
            for (const item of parsed.files) {
                if (!isObject(item) || !hasNonEmptyString(item, "id") || !hasNonEmptyString(item, "path")) {
                    throw new ConnectorProviderError("validation", "Nextcloud sync cursor is invalid");
                }
                files.push({
                    id: item.id as string,
                    path: item.path as string,
                    ...(typeof item.etag === "string" ? { etag: item.etag } : {}),
                    ...(typeof item.checksum === "string" ? { checksum: item.checksum } : {}),
                    ...(typeof item.size === "number" ? { size: item.size } : {}),
                });
            }
            return { version: 1, files };
        },
        catch: (error) =>
            error instanceof ConnectorProviderError
                ? error
                : new ConnectorProviderError("validation", "Nextcloud sync cursor is invalid", { cause: error }),
    });
}

function walkNextcloudFiles(
    context: NextcloudClientContext,
    rootFolderPath: string
): Effect.Effect<NextcloudFileItem[], ConnectorProviderError> {
    return Effect.gen(function* () {
        const root = normalizeNextcloudFolderPath(rootFolderPath);
        const rootEntry = yield* propfindSingle(context, root);
        if (!rootEntry.isFolder) {
            return yield* Effect.fail(new ConnectorProviderError("validation", "Nextcloud resource is not a folder"));
        }

        const files: NextcloudFileItem[] = [];
        const queue: Array<{ path: string; id: string | null }> = [{ path: root, id: rootEntry.id }];
        while (queue.length > 0) {
            const folder = queue.shift();
            if (!folder) {
                break;
            }
            const entries = yield* listNextcloudFolderEntries(context, folder.path, folder.id);
            for (const entry of entries) {
                if (entry.isFolder) {
                    queue.push({ path: entry.path, id: entry.id });
                    continue;
                }
                const relativePath = relativeNextcloudPath(root, entry.path);
                if (!relativePath) {
                    continue;
                }
                files.push({ ...entry, isFolder: false, relativePath });
            }
        }
        files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        return files;
    });
}

function listNextcloudFolderEntries(
    context: NextcloudClientContext,
    folderPath: string,
    parentId?: string | null
): Effect.Effect<NextcloudDavEntry[], ConnectorProviderError> {
    return Effect.gen(function* () {
        const normalizedFolderPath = normalizeNextcloudFolderPath(folderPath);
        const xml = yield* propfind(context, normalizedFolderPath, "1");
        const entries = parseNextcloudMultistatus(context, xml, parentId ?? null).filter(
            (entry) => entry.path !== normalizedFolderPath
        );
        return entries;
    });
}

function propfindSingle(
    context: NextcloudClientContext,
    folderPath: string
): Effect.Effect<NextcloudDavEntry, ConnectorProviderError> {
    return Effect.gen(function* () {
        const normalizedFolderPath = normalizeNextcloudFolderPath(folderPath);
        const xml = yield* propfind(context, normalizedFolderPath, "0");
        const [entry] = parseNextcloudMultistatus(context, xml, null).filter((candidate) =>
            pathsEqual(candidate.path, normalizedFolderPath)
        );
        if (!entry) {
            return yield* Effect.fail(new ConnectorProviderError("not-found", "Nextcloud resource was not found"));
        }
        return entry;
    });
}

function propfind(
    context: NextcloudClientContext,
    folderPath: string,
    depth: "0" | "1"
): Effect.Effect<string, ConnectorProviderError> {
    return nextcloudRequestText(context, folderPath, {
        method: "PROPFIND",
        headers: {
            Depth: depth,
            "content-type": "application/xml; charset=utf-8",
        },
        body: NEXTCLOUD_PROPFIND_BODY,
    });
}

function getNextcloudFile(
    context: NextcloudClientContext,
    locator: ConnectorFileLocator
): Effect.Effect<ConnectorBinaryFile, ConnectorProviderError> {
    return Effect.gen(function* () {
        const path =
            locator.resourceKind === "file"
                ? normalizeNextcloudFolderPath(locator.resourceId)
                : joinNextcloudPath(locator.resourceId, locator.path);
        const response = yield* nextcloudRequest(context, path, { method: "GET" });
        const bytes = new Uint8Array(
            yield* Effect.tryPromise({
                try: () => response.arrayBuffer(),
                catch: (error) =>
                    new ConnectorProviderError("provider", "Nextcloud file download failed", { cause: error }),
            })
        );
        return {
            locator,
            bytes,
            size: bytes.byteLength,
            contentType: response.headers.get("content-type") ?? undefined,
        };
    });
}

function nextcloudRequestText(
    context: NextcloudClientContext,
    path: string,
    init: RequestInit
): Effect.Effect<string, ConnectorProviderError> {
    return Effect.gen(function* () {
        const response = yield* nextcloudRequest(context, path, init);
        return yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (error) =>
                new ConnectorProviderError("provider", "Nextcloud response body could not be read", { cause: error }),
        });
    });
}

function nextcloudRequest(
    context: NextcloudClientContext,
    path: string,
    init: RequestInit
): Effect.Effect<Response, ConnectorProviderError> {
    return Effect.tryPromise({
        try: async () => {
            const response = await context.fetch(nextcloudDavUrl(context, path), {
                ...init,
                headers: {
                    authorization: basicAuthHeader(context.username, context.appPassword),
                    ...(init.headers ?? {}),
                },
            });
            if (response.ok || response.status === 207) {
                return response;
            }
            if (response.status === 401 || response.status === 403) {
                throw new ConnectorProviderError("auth", "Nextcloud credentials were rejected");
            }
            if (response.status === 404) {
                throw new ConnectorProviderError("not-found", "Nextcloud resource was not found");
            }
            throw new ConnectorProviderError("provider", `Nextcloud request failed with status ${response.status}`);
        },
        catch: (error) =>
            error instanceof ConnectorProviderError
                ? error
                : new ConnectorProviderError("provider", "Nextcloud request failed", { cause: error }),
    });
}

function nextcloudDavUrl(context: NextcloudClientContext, path: string): string {
    const url = new URL(context.baseUrl);
    const basePath = url.pathname.replace(/\/+$/u, "");
    const encodedPath = encodePath(normalizeNextcloudFolderPath(path));
    url.pathname = `${basePath}/remote.php/dav/files/${encodeURIComponent(context.username)}${encodedPath ? `/${encodedPath}` : ""}`;
    return url.toString();
}

function nextcloudWebUrl(context: NextcloudClientContext, path: string): string {
    const url = new URL(context.baseUrl);
    const basePath = url.pathname.replace(/\/+$/u, "");
    url.pathname = `${basePath}/apps/files/`;
    url.searchParams.set("dir", `/${normalizeNextcloudFolderPath(path)}`);
    return url.toString();
}

function mapNextcloudEntryToChild(context: NextcloudClientContext, entry: NextcloudDavEntry): ConnectorResourceChild {
    return {
        id: entry.path,
        parentId: entry.parentId,
        providerItemId: entry.id,
        name: entry.name,
        path: entry.path,
        kind: entry.isFolder ? "folder" : "file",
        webUrl: entry.webUrl || nextcloudWebUrl(context, entry.path),
        size: entry.size,
        versionId: entry.etag,
    };
}

function parseNextcloudMultistatus(
    context: NextcloudClientContext,
    xml: string,
    parentId: string | null
): NextcloudDavEntry[] {
    const entries: NextcloudDavEntry[] = [];
    for (const responseBlock of xml.matchAll(/<(?:[\w.-]+:)?response\b[\s\S]*?<\/(?:[\w.-]+:)?response>/gu)) {
        const block = responseBlock[0];
        const href = xmlText(block, "href");
        if (!href) {
            continue;
        }
        const path = pathFromDavHref(href, context.username);
        const name = xmlText(block, "displayname") || path.split("/").filter(Boolean).at(-1) || "Nextcloud files";
        const etag = stripEtagQuotes(xmlText(block, "getetag"));
        const checksum = firstChecksum(xmlText(block, "checksums"));
        const contentType = xmlText(block, "getcontenttype") || undefined;
        const mimeType = contentType?.split(";", 1)[0]?.trim() || contentType;
        const size = numberFromXmlText(xmlText(block, "getcontentlength")) ?? numberFromXmlText(xmlText(block, "size"));
        const isFolder = /<(?:[\w.-]+:)?collection\b/u.test(xmlTextRaw(block, "resourcetype"));
        const id = xmlText(block, "fileid") || path || "/";
        entries.push({
            id,
            parentId,
            path,
            name,
            isFolder,
            webUrl: nextcloudWebUrl(context, path),
            ...(size !== undefined ? { size } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(contentType ? { contentType } : {}),
            ...(checksum ? { checksum } : {}),
            ...(etag ? { etag } : {}),
        });
    }
    return entries;
}

function pathFromDavHref(href: string, username: string): string {
    const url =
        href.startsWith("http://") || href.startsWith("https://")
            ? new URL(href)
            : new URL(href, "https://nextcloud.local");
    const segments = url.pathname.split("/").filter(Boolean);
    const filesIndex = segments.findIndex((segment, index) => segment === "files" && segments[index - 1] === "dav");
    if (filesIndex === -1 || segments[filesIndex + 1] === undefined) {
        return "";
    }
    const userSegment = safeDecodeURIComponent(segments[filesIndex + 1] ?? "");
    if (userSegment !== username) {
        return "";
    }
    return segments
        .slice(filesIndex + 2)
        .map(safeDecodeURIComponent)
        .filter(Boolean)
        .join("/");
}

function joinNextcloudPath(resourceId: string, path: string): string {
    const resourcePath = normalizeNextcloudFolderPath(resourceId);
    const filePath = normalizeNextcloudFolderPath(path);
    return [resourcePath, filePath].filter(Boolean).join("/");
}

function relativeNextcloudPath(rootFolderPath: string, path: string): string {
    const root = normalizeNextcloudFolderPath(rootFolderPath);
    const normalizedPath = normalizeNextcloudFolderPath(path);
    if (!root) {
        return normalizedPath;
    }
    if (normalizedPath === root) {
        return "";
    }
    return normalizedPath.startsWith(`${root}/`) ? normalizedPath.slice(root.length + 1) : normalizedPath;
}

function pathsEqual(left: string, right: string): boolean {
    return normalizeNextcloudFolderPath(left) === normalizeNextcloudFolderPath(right);
}

function encodePath(path: string): string {
    return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function basicAuthHeader(username: string, password: string): string {
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function xmlText(block: string, localName: string): string {
    return stripXmlTags(xmlTextRaw(block, localName)).trim();
}

function xmlTextRaw(block: string, localName: string): string {
    const escaped = escapeRegExp(localName);
    const match = block.match(
        new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`, "u")
    );
    return decodeXmlEntities(match?.[1] ?? "");
}

function stripXmlTags(value: string): string {
    return value.replace(/<[^>]+>/gu, "");
}

function decodeXmlEntities(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_entity, raw: string) => {
        switch (raw.toLowerCase()) {
            case "amp":
                return "&";
            case "lt":
                return "<";
            case "gt":
                return ">";
            case "quot":
                return '"';
            case "apos":
                return "'";
            default:
                if (raw.startsWith("#x")) {
                    return String.fromCodePoint(Number.parseInt(raw.slice(2), 16));
                }
                if (raw.startsWith("#")) {
                    return String.fromCodePoint(Number.parseInt(raw.slice(1), 10));
                }
                return `&${raw};`;
        }
    });
}

function firstChecksum(value: string): string | undefined {
    return value
        .split(/\s+/u)
        .map((item) => item.trim())
        .find(Boolean);
}

function stripEtagQuotes(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed ? trimmed.replace(/^"|"$/gu, "") : undefined;
}

function numberFromXmlText(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function hashString(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function hasNonEmptyString(value: Record<string, unknown>, key: string): boolean {
    return typeof value[key] === "string" && (value[key] as string).trim().length > 0;
}

function isObject(value: unknown): value is ConnectorCredentialPayloadData {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
