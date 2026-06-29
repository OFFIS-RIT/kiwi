import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import type {
    ConnectorAdapter,
    ConnectorBinaryFile,
    ConnectorCredentialDescriptor,
    ConnectorFileLocator,
    ConnectorResource,
    ConnectorResourceCapabilities,
    ConnectorResourceChange,
    ConnectorResourceChangeSet,
    ConnectorResourceDelta,
    ConnectorResourceSnapshot,
    ConnectorResourceVersion,
    ConnectorResourceChild,
    FetchLike,
    VersionedConnectorCredentialPayload,
} from "./types";
import { ConnectorProviderError } from "./types";

export const SHAREPOINT_PROVIDER = "sharepoint";
export const SHAREPOINT_CREDENTIAL_VERSION = "v1";

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const GRAPH_TOKEN_SCOPE = "https://graph.microsoft.com/.default";
const MAX_SHAREPOINT_DELTA_PAGES = 50;

export const SHAREPOINT_RESOURCE_CAPABILITIES: ConnectorResourceCapabilities = {
    versions: false,
    cursorSync: true,
    children: true,
    binaryFiles: true,
};

export type SharePointConnectorCredentialData = {
    tenantId: string;
    clientId: string;
    clientSecret: string;
};

export type SharePointInstallationCredentialData = {
    siteId: string;
    driveId: string;
    folderPath: string;
    folderId?: string;
};

export type SharePointConnectorCredentials = VersionedConnectorCredentialPayload<"app", typeof SHAREPOINT_PROVIDER> & {
    data: SharePointConnectorCredentialData;
};

export type SharePointInstallationCredentials = VersionedConnectorCredentialPayload<
    "installation",
    typeof SHAREPOINT_PROVIDER
> & {
    data: SharePointInstallationCredentialData;
};

type SharePointAdapterOptions = {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    siteId: string;
    driveId: string;
    folderPath: string;
    folderId?: string;
    fetch?: FetchLike;
    graphBaseUrl?: string;
    tokenBaseUrl?: string;
};

type SharePointClientContext = {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    siteId: string;
    driveId: string;
    rootFolderPath: string;
    rootFolderId?: string;
    fetch: FetchLike;
    graphBaseUrl: string;
    tokenBaseUrl: string;
};

type SharePointAccessTokenResponse = {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
};

type SharePointDriveItem = {
    id?: unknown;
    name?: unknown;
    webUrl?: unknown;
    size?: unknown;
    eTag?: unknown;
    cTag?: unknown;
    deleted?: unknown;
    file?: unknown;
    folder?: unknown;
    parentReference?: unknown;
};

type SharePointDriveItemPage = {
    value?: unknown;
    "@odata.nextLink"?: unknown;
    "@odata.deltaLink"?: unknown;
};

type SharePointCursorState =
    | {
          version: 1;
          mode: "delta";
          deltaLink: string;
      }
    | {
          version: 1;
          mode: "file";
          itemId: string;
          path: string;
          etag?: string;
          size?: number;
      };

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export const sharepointCredentialDescriptors = {
    app: {
        subject: "app",
        version: SHAREPOINT_CREDENTIAL_VERSION,
        validate: isSharePointConnectorCredentialData,
    },
    installation: {
        subject: "installation",
        version: SHAREPOINT_CREDENTIAL_VERSION,
        validate: isSharePointInstallationCredentialData,
    },
} satisfies Record<"app" | "installation", ConnectorCredentialDescriptor>;

export function normalizeSharePointGraphBaseUrl(value?: string): string {
    const trimmed = (value ?? DEFAULT_GRAPH_BASE_URL).trim();
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("SharePoint Graph base URL must be absolute");
    }

    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/u, "");
}

export function normalizeSharePointFolderPath(value: string): string {
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

export function publicSharePointResourceId(folderPath: string): string {
    const normalized = normalizeSharePointFolderPath(folderPath);
    return normalized.length > 0 ? normalized : "/";
}

export function createSharePointAdapter(options: SharePointAdapterOptions): ConnectorAdapter {
    const context: SharePointClientContext = {
        tenantId: normalizeTenantId(options.tenantId),
        clientId: requireNonEmptyString(options.clientId, "clientId"),
        clientSecret: requireNonEmptyString(options.clientSecret, "clientSecret"),
        siteId: requireNonEmptyString(options.siteId, "siteId"),
        driveId: requireNonEmptyString(options.driveId, "driveId"),
        rootFolderPath: normalizeSharePointFolderPath(options.folderPath),
        rootFolderId: normalizeOptionalString(options.folderId),
        fetch: options.fetch ?? defaultFetch,
        graphBaseUrl: normalizeSharePointGraphBaseUrl(options.graphBaseUrl),
        tokenBaseUrl: normalizeTokenBaseUrl(options.tokenBaseUrl),
    };

    return {
        provider: SHAREPOINT_PROVIDER,
        resourceKind: "folder",
        capabilities: SHAREPOINT_RESOURCE_CAPABILITIES,
        getResource: Effect.fn("SharePointAdapter.getResource")(function* (resourceId: string) {
            return yield* getSharePointResource(context, resourceId);
        }),
        listResources: Effect.fn("SharePointAdapter.listResources")(function* () {
            const root = yield* resolveSharePointRootItem(context);
            return [mapSharePointItemToResource(context, root, context.rootFolderPath)];
        }),
        listResourceVersions: unsupportedListResourceVersions(),
        loadSnapshot: unsupportedLoadSnapshot(),
        compareVersions: unsupportedCompareVersions(),
        readFile: Effect.fn("SharePointAdapter.readFile")(function* (locator: ConnectorFileLocator) {
            const file = yield* getSharePointFile(context, locator);
            return new TextDecoder().decode(file.bytes);
        }),
        listChildren: Effect.fn("SharePointAdapter.listChildren")(function* (parentId?: string) {
            const folderItem = parentId
                ? yield* getSharePointDriveItemById(context, parentId)
                : yield* resolveSharePointRootItem(context);
            assertSharePointFolder(folderItem, "SharePoint children can only be listed for folders");
            const entries = yield* listSharePointFolderChildren(context, requireDriveItemId(folderItem));
            return entries.map((entry) => mapSharePointItemToChild(context, entry));
        }),
        listChanges: Effect.fn("SharePointAdapter.listChanges")(function* (resourceId: string, cursor?: string) {
            return yield* listSharePointChanges(context, resourceId, cursor);
        }),
        openFile: Effect.fn("SharePointAdapter.openFile")(function* (locator: ConnectorFileLocator) {
            return yield* getSharePointFile(context, locator);
        }),
    };
}

export function isSharePointConnectorCredentials(value: unknown): value is SharePointConnectorCredentials {
    return isVersionedSharePointPayload(value, "app") && isSharePointConnectorCredentialData(value.data);
}

export function isSharePointInstallationCredentials(value: unknown): value is SharePointInstallationCredentials {
    return isVersionedSharePointPayload(value, "installation") && isSharePointInstallationCredentialData(value.data);
}

export function isSharePointConnectorCredentialData(value: unknown): value is SharePointConnectorCredentialData {
    if (!isPlainRecord(value)) {
        return false;
    }

    return (
        hasNonEmptyString(value, "tenantId") &&
        hasNonEmptyString(value, "clientId") &&
        hasNonEmptyString(value, "clientSecret")
    );
}

export function isSharePointInstallationCredentialData(value: unknown): value is SharePointInstallationCredentialData {
    if (!isPlainRecord(value)) {
        return false;
    }

    if (!hasNonEmptyString(value, "siteId") || !hasNonEmptyString(value, "driveId")) {
        return false;
    }

    if (!hasNonEmptyString(value, "folderPath")) {
        return false;
    }

    return value.folderId === undefined || typeof value.folderId === "string";
}

export function requestSharePointAccessToken(options: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    fetch?: FetchLike;
    tokenBaseUrl?: string;
}): Effect.Effect<string, ConnectorProviderError> {
    return Effect.tryPromise({
        try: async () => {
            const tenantId = normalizeTenantId(options.tenantId);
            const tokenBaseUrl = normalizeTokenBaseUrl(options.tokenBaseUrl);
            const tokenUrl = `${tokenBaseUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
            const body = new URLSearchParams({
                client_id: options.clientId,
                client_secret: options.clientSecret,
                grant_type: "client_credentials",
                scope: GRAPH_TOKEN_SCOPE,
            });
            const request = options.fetch ?? defaultFetch;
            const response = await request(tokenUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                },
                body,
            });
            if (!response.ok) {
                throw new ConnectorProviderError("auth", `SharePoint token request failed with ${response.status}`);
            }

            const payload = (await response.json()) as SharePointAccessTokenResponse;
            if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
                throw new ConnectorProviderError("auth", "SharePoint token response did not include an access token");
            }

            return payload.access_token;
        },
        catch: (cause) => toConnectorProviderError(cause),
    });
}

function unsupportedListResourceVersions(): ConnectorAdapter["listResourceVersions"] {
    return Effect.fn("SharePointAdapter.listResourceVersions")(function* (_resourceId: string) {
        return yield* unsupportedVersionOperation<ConnectorResourceVersion[]>();
    });
}

function unsupportedLoadSnapshot(): ConnectorAdapter["loadSnapshot"] {
    return Effect.fn("SharePointAdapter.loadSnapshot")(function* (
        _resourceId: string,
        _versionName: string,
        _versionId?: string
    ) {
        return yield* unsupportedVersionOperation<ConnectorResourceSnapshot>();
    });
}

function unsupportedCompareVersions(): ConnectorAdapter["compareVersions"] {
    return Effect.fn("SharePointAdapter.compareVersions")(function* (
        _resourceId: string,
        _fromVersionId: string,
        _toVersionId: string
    ) {
        return yield* unsupportedVersionOperation<ConnectorResourceDelta>();
    });
}

function unsupportedVersionOperation<A>(): Effect.Effect<A, ConnectorProviderError> {
    return Effect.fail(
        new ConnectorProviderError("provider", "SharePoint uses cursor-based sync and does not expose named versions")
    );
}

function getSharePointResource(
    context: SharePointClientContext,
    resourceId: string
): Effect.Effect<ConnectorResource, ConnectorProviderError> {
    return Effect.gen(function* () {
        if (resourceId === "/" || normalizeSharePointFolderPath(resourceId) === context.rootFolderPath) {
            const root = yield* resolveSharePointRootItem(context);
            return mapSharePointItemToResource(context, root, context.rootFolderPath);
        }

        const item = yield* getSharePointDriveItemById(context, resourceId);
        return mapSharePointItemToResource(context, item);
    });
}

function resolveSharePointRootItem(
    context: SharePointClientContext
): Effect.Effect<SharePointDriveItem, ConnectorProviderError> {
    if (context.rootFolderId) {
        return getSharePointDriveItemById(context, context.rootFolderId);
    }

    return getSharePointDriveItemByPath(context, context.rootFolderPath);
}

function listSharePointChanges(
    context: SharePointClientContext,
    resourceId: string,
    cursor?: string
): Effect.Effect<ConnectorResourceChangeSet, ConnectorProviderError> {
    return Effect.gen(function* () {
        const decodedCursor = decodeSharePointCursor(cursor);
        const item = yield* getSharePointResourceItemForSync(context, resourceId);
        if (!isSharePointFolder(item)) {
            return yield* listSingleFileSharePointChanges(context, item, decodedCursor);
        }

        return yield* listSharePointFolderChanges(context, item, decodedCursor);
    });
}

function getSharePointResourceItemForSync(
    context: SharePointClientContext,
    resourceId: string
): Effect.Effect<SharePointDriveItem, ConnectorProviderError> {
    if (resourceId === "/" || normalizeSharePointFolderPath(resourceId) === context.rootFolderPath) {
        return resolveSharePointRootItem(context);
    }

    return getSharePointDriveItemById(context, resourceId);
}

function listSingleFileSharePointChanges(
    context: SharePointClientContext,
    item: SharePointDriveItem,
    cursor: SharePointCursorState | null
): Effect.Effect<ConnectorResourceChangeSet, ConnectorProviderError> {
    return Effect.gen(function* () {
        const path = mapSharePointItemPath(context, item);
        const etag = optionalString(item.eTag);
        const state: SharePointCursorState = {
            version: 1,
            mode: "file",
            itemId: requireDriveItemId(item),
            path,
            etag,
            size: numberFromValue(item.size),
        };
        const nextCursor = encodeSharePointCursor(state);
        const unchanged = cursor?.mode === "file" && cursor.itemId === state.itemId && cursor.etag === state.etag;
        const changes: ConnectorResourceChange[] = unchanged
            ? []
            : [mapSharePointFileToChange(context, item, true, driveItemName(item, path))];

        return {
            changes,
            cursor: nextCursor,
            versionId: sharePointVersionId(nextCursor),
            isInitial: cursor === null,
        };
    });
}

function listSharePointFolderChanges(
    context: SharePointClientContext,
    item: SharePointDriveItem,
    cursor: SharePointCursorState | null
): Effect.Effect<ConnectorResourceChangeSet, ConnectorProviderError> {
    return Effect.gen(function* () {
        const rootPath = mapSharePointItemPath(context, item);
        const itemId = requireDriveItemId(item);
        const firstRequest =
            cursor?.mode === "delta" ? cursor.deltaLink : sharePointItemEndpoint(context, itemId, "delta");
        const page = yield* collectSharePointDeltaPages(context, firstRequest);
        const hydratedItems: SharePointDriveItem[] = [];
        for (const changedItem of page.items) {
            hydratedItems.push(yield* hydrateSharePointDeltaItem(context, changedItem));
        }
        const changes = hydratedItems
            .map((changedItem) => mapSharePointDeltaItemToChange(context, rootPath, changedItem, cursor === null))
            .filter((change): change is ConnectorResourceChange => change !== null);
        const nextCursor = encodeSharePointCursor({
            version: 1,
            mode: "delta",
            deltaLink: page.deltaLink,
        });

        return {
            changes,
            cursor: nextCursor,
            versionId: sharePointVersionId(nextCursor),
            isInitial: cursor === null,
        };
    });
}

function collectSharePointDeltaPages(
    context: SharePointClientContext,
    initialRequest: string
): Effect.Effect<{ items: SharePointDriveItem[]; deltaLink: string }, ConnectorProviderError> {
    return Effect.gen(function* () {
        const items: SharePointDriveItem[] = [];
        let request: string | null = initialRequest;
        let deltaLink: string | null = null;
        let pageCount = 0;

        while (request !== null) {
            pageCount += 1;
            if (pageCount > MAX_SHAREPOINT_DELTA_PAGES) {
                yield* Effect.fail(
                    new ConnectorProviderError("limit", "SharePoint delta paging exceeded the maximum page count")
                );
            }

            const page: SharePointDriveItemPage = yield* sharePointJsonRequest<SharePointDriveItemPage>(
                context,
                request
            );
            if (Array.isArray(page.value)) {
                items.push(...page.value.filter(isPlainRecord));
            }

            if (typeof page["@odata.nextLink"] === "string") {
                request = page["@odata.nextLink"];
                continue;
            }

            if (typeof page["@odata.deltaLink"] === "string") {
                deltaLink = page["@odata.deltaLink"];
                request = null;
                continue;
            }

            yield* Effect.fail(
                new ConnectorProviderError("provider", "SharePoint delta response did not include a delta link")
            );
        }

        const finalDeltaLink = deltaLink;
        if (finalDeltaLink === null) {
            return yield* Effect.fail(
                new ConnectorProviderError("provider", "SharePoint delta response did not include a delta link")
            );
        }

        return { items, deltaLink: finalDeltaLink };
    });
}

function hydrateSharePointDeltaItem(
    context: SharePointClientContext,
    item: SharePointDriveItem
): Effect.Effect<SharePointDriveItem, ConnectorProviderError> {
    if (isDeletedDriveItem(item) || hasSharePointParentPath(item)) {
        return Effect.succeed(item);
    }

    return getSharePointDriveItemById(context, requireDriveItemId(item));
}

function getSharePointFile(
    context: SharePointClientContext,
    locator: ConnectorFileLocator
): Effect.Effect<ConnectorBinaryFile, ConnectorProviderError> {
    return Effect.gen(function* () {
        const item =
            locator.resourceKind === "file"
                ? yield* getSharePointDriveItemById(context, locator.resourceId)
                : yield* resolveFileItemFromFolderLocator(context, locator);
        assertSharePointFile(item, "SharePoint file content can only be opened for files");
        const response = yield* sharePointBytesRequest(
            context,
            sharePointItemEndpoint(context, requireDriveItemId(item), "content")
        );
        const contentType = response.contentType ?? optionalMimeType(item.file);

        return {
            locator,
            bytes: response.bytes,
            size: response.bytes.byteLength,
            contentType,
        };
    });
}

function resolveFileItemFromFolderLocator(
    context: SharePointClientContext,
    locator: ConnectorFileLocator
): Effect.Effect<SharePointDriveItem, ConnectorProviderError> {
    return Effect.gen(function* () {
        const folder = yield* getSharePointResourceItemForSync(context, locator.resourceId);
        assertSharePointFolder(folder, "SharePoint folder locator must point at a folder");
        const folderPath = mapSharePointItemPath(context, folder);
        const filePath = joinSharePointPath(folderPath, locator.path);
        return yield* getSharePointDriveItemByPath(context, filePath);
    });
}

function getSharePointDriveItemById(
    context: SharePointClientContext,
    itemId: string
): Effect.Effect<SharePointDriveItem, ConnectorProviderError> {
    return sharePointJsonRequest<SharePointDriveItem>(context, sharePointItemEndpoint(context, itemId));
}

function getSharePointDriveItemByPath(
    context: SharePointClientContext,
    path: string
): Effect.Effect<SharePointDriveItem, ConnectorProviderError> {
    return sharePointJsonRequest<SharePointDriveItem>(context, sharePointPathEndpoint(context, path));
}

function listSharePointFolderChildren(
    context: SharePointClientContext,
    folderId: string
): Effect.Effect<SharePointDriveItem[], ConnectorProviderError> {
    return Effect.gen(function* () {
        const children: SharePointDriveItem[] = [];
        let request: string | null = sharePointItemEndpoint(context, folderId, "children");

        while (request !== null) {
            const page: SharePointDriveItemPage = yield* sharePointJsonRequest<SharePointDriveItemPage>(
                context,
                request
            );
            if (Array.isArray(page.value)) {
                children.push(...page.value.filter(isPlainRecord));
            }

            request = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : null;
        }

        return children;
    });
}

function sharePointJsonRequest<T>(
    context: SharePointClientContext,
    endpoint: string
): Effect.Effect<T, ConnectorProviderError> {
    return Effect.gen(function* () {
        const token = yield* requestSharePointAccessToken(context);
        const response = yield* Effect.tryPromise({
            try: () =>
                context.fetch(sharePointRequestUrl(context, endpoint), {
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${token}`,
                    },
                }),
            catch: (cause) => new ConnectorProviderError("provider", "SharePoint request failed", { cause }),
        });

        if (response.status === 404) {
            yield* Effect.fail(new ConnectorProviderError("not-found", "SharePoint item was not found"));
        }

        if (!response.ok) {
            yield* Effect.fail(
                new ConnectorProviderError("provider", `SharePoint request failed with ${response.status}`)
            );
        }

        return yield* Effect.tryPromise({
            try: () => response.json() as Promise<T>,
            catch: (cause) =>
                new ConnectorProviderError("provider", "SharePoint response body could not be parsed", { cause }),
        });
    });
}

function sharePointBytesRequest(
    context: SharePointClientContext,
    endpoint: string
): Effect.Effect<{ bytes: Uint8Array; contentType?: string }, ConnectorProviderError> {
    return Effect.gen(function* () {
        const token = yield* requestSharePointAccessToken(context);
        const response = yield* Effect.tryPromise({
            try: () =>
                context.fetch(sharePointRequestUrl(context, endpoint), {
                    headers: {
                        authorization: `Bearer ${token}`,
                    },
                }),
            catch: (cause) => new ConnectorProviderError("provider", "SharePoint file download failed", { cause }),
        });

        if (response.status === 404) {
            yield* Effect.fail(new ConnectorProviderError("not-found", "SharePoint file was not found"));
        }

        if (!response.ok) {
            yield* Effect.fail(
                new ConnectorProviderError("provider", `SharePoint file download failed with ${response.status}`)
            );
        }

        const buffer = yield* Effect.tryPromise({
            try: () => response.arrayBuffer(),
            catch: (cause) =>
                new ConnectorProviderError("provider", "SharePoint file response body could not be read", { cause }),
        });

        const contentType = response.headers.get("content-type") ?? undefined;
        return { bytes: new Uint8Array(buffer), contentType };
    });
}

function mapSharePointItemToResource(
    context: SharePointClientContext,
    item: SharePointDriveItem,
    fallbackPath?: string
): ConnectorResource {
    const path =
        fallbackPath === undefined ? mapSharePointItemPath(context, item) : normalizeSharePointFolderPath(fallbackPath);
    return {
        provider: SHAREPOINT_PROVIDER,
        kind: isSharePointFolder(item) ? "folder" : "file",
        id: requireDriveItemId(item),
        displayName: driveItemName(item, path),
        webUrl: optionalString(item.webUrl) ?? sharePointWebUrl(context, path),
        private: true,
        path,
        providerItemId: requireDriveItemId(item),
        metadata: {
            siteId: context.siteId,
            driveId: context.driveId,
            path,
            providerItemId: requireDriveItemId(item),
        },
        defaultVersion: null,
    };
}

function mapSharePointItemToChild(context: SharePointClientContext, item: SharePointDriveItem): ConnectorResourceChild {
    const path = mapSharePointItemPath(context, item);
    return {
        id: requireDriveItemId(item),
        parentId: sharePointParentId(item),
        providerItemId: requireDriveItemId(item),
        name: driveItemName(item, path),
        path,
        kind: isSharePointFolder(item) ? "folder" : "file",
        webUrl: optionalString(item.webUrl) ?? sharePointWebUrl(context, path),
        size: numberFromValue(item.size),
        versionId: optionalString(item.eTag) ?? optionalString(item.cTag),
    };
}

function mapSharePointDeltaItemToChange(
    context: SharePointClientContext,
    rootPath: string,
    item: SharePointDriveItem,
    isInitial: boolean
): ConnectorResourceChange | null {
    const path = mapSharePointItemPath(context, item);
    const relativePath = relativeSharePointPath(rootPath, path);
    if (isDeletedDriveItem(item)) {
        return {
            status: "deleted",
            oldPath: relativePath || path || requireDriveItemId(item),
            providerItemId: requireDriveItemId(item),
        };
    }

    if (!isSharePointFile(item)) {
        return null;
    }

    return mapSharePointFileToChange(context, item, isInitial, relativePath);
}

function mapSharePointFileToChange(
    context: SharePointClientContext,
    item: SharePointDriveItem,
    isInitial: boolean,
    relativePath?: string
): ConnectorResourceChange {
    const path = relativePath ?? mapSharePointItemPath(context, item);
    const etag = optionalString(item.eTag) ?? optionalString(item.cTag);
    return {
        status: isInitial ? "added" : "modified",
        newPath: path,
        providerItemId: requireDriveItemId(item),
        etag,
        displayName: driveItemName(item, path),
        mimeType: optionalMimeType(item.file),
        contentType: optionalMimeType(item.file),
        size: numberFromValue(item.size),
        checksum: etag,
        webUrl: optionalString(item.webUrl) ?? sharePointWebUrl(context, mapSharePointItemPath(context, item)),
        contentAccessMode: "binary",
        processingKind: "document",
    } as ConnectorResourceChange;
}

function mapSharePointItemPath(context: SharePointClientContext, item: SharePointDriveItem): string {
    const parentPath = sharePointParentPath(item);
    const name = optionalString(item.name);
    if (!name) {
        return context.rootFolderPath;
    }

    return joinSharePointPath(parentPath, name);
}

function hasSharePointParentPath(item: SharePointDriveItem): boolean {
    const parentReference = isPlainRecord(item.parentReference) ? item.parentReference : null;
    return parentReference !== null && typeof parentReference.path === "string" && parentReference.path.length > 0;
}

function sharePointParentPath(item: SharePointDriveItem): string {
    const parentReference = isPlainRecord(item.parentReference) ? item.parentReference : null;
    const rawPath = parentReference && typeof parentReference.path === "string" ? parentReference.path : "";
    const marker = "root:";
    const markerIndex = rawPath.indexOf(marker);
    if (markerIndex === -1) {
        return "";
    }

    const afterRoot = rawPath.slice(markerIndex + marker.length).replace(/^\/+|\/+$/gu, "");
    return normalizeSharePointFolderPath(safeDecodeURIComponent(afterRoot));
}

function sharePointParentId(item: SharePointDriveItem): string | null {
    const parentReference = isPlainRecord(item.parentReference) ? item.parentReference : null;
    return parentReference && typeof parentReference.id === "string" ? parentReference.id : null;
}

function sharePointPathEndpoint(context: SharePointClientContext, path: string): string {
    const encodedPath = encodeSharePointPath(path);
    const driveId = encodeURIComponent(context.driveId);
    if (encodedPath.length === 0) {
        return `/drives/${driveId}/root`;
    }

    return `/drives/${driveId}/root:/${encodedPath}:`;
}

function sharePointItemEndpoint(context: SharePointClientContext, itemId: string, suffix?: string): string {
    const driveId = encodeURIComponent(context.driveId);
    const encodedItemId = encodeURIComponent(itemId);
    const base = `/drives/${driveId}/items/${encodedItemId}`;
    return suffix ? `${base}/${suffix}` : base;
}

function sharePointRequestUrl(context: SharePointClientContext, endpoint: string): string {
    if (/^https?:\/\//u.test(endpoint)) {
        return endpoint;
    }

    const base = context.graphBaseUrl.endsWith("/") ? context.graphBaseUrl : `${context.graphBaseUrl}/`;
    return new URL(endpoint.replace(/^\/+/, ""), base).toString();
}

function sharePointWebUrl(context: SharePointClientContext, path: string): string {
    const url = new URL(`${context.graphBaseUrl}/drives/${encodeURIComponent(context.driveId)}/root`);
    if (path) {
        url.searchParams.set("path", path);
    }

    return url.toString();
}

function encodeSharePointPath(path: string): string {
    return normalizeSharePointFolderPath(path)
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

function joinSharePointPath(...parts: Array<string | null | undefined>): string {
    return parts
        .flatMap((part) => normalizeSharePointFolderPath(part ?? "").split("/"))
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("/");
}

function relativeSharePointPath(rootPath: string, path: string): string {
    const root = normalizeSharePointFolderPath(rootPath);
    const normalizedPath = normalizeSharePointFolderPath(path);
    if (!root) {
        return normalizedPath;
    }

    if (normalizedPath === root) {
        return "";
    }

    const prefix = `${root}/`;
    return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

function encodeSharePointCursor(state: SharePointCursorState): string {
    const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
    return `sharepoint:${SHAREPOINT_CREDENTIAL_VERSION}:${payload}`;
}

function decodeSharePointCursor(value: string | undefined): SharePointCursorState | null {
    if (!value) {
        return null;
    }

    const prefix = `sharepoint:${SHAREPOINT_CREDENTIAL_VERSION}:`;
    if (!value.startsWith(prefix)) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8")) as unknown;
        if (!isPlainRecord(payload) || payload.version !== 1) {
            return null;
        }

        if (payload.mode === "delta" && typeof payload.deltaLink === "string") {
            return payload as SharePointCursorState;
        }

        if (payload.mode === "file" && typeof payload.itemId === "string" && typeof payload.path === "string") {
            return payload as SharePointCursorState;
        }
    } catch {
        return null;
    }

    return null;
}

function sharePointVersionId(cursor: string): string {
    return `sharepoint:${createHash("sha256").update(cursor).digest("hex").slice(0, 32)}`;
}

function normalizeTenantId(value: string): string {
    const trimmed = requireNonEmptyString(value, "tenantId");
    if (/[/?#]/u.test(trimmed)) {
        throw new Error("SharePoint tenant ID must not contain URL separators");
    }

    return trimmed;
}

function normalizeTokenBaseUrl(value?: string): string {
    const trimmed = (value ?? "https://login.microsoftonline.com").trim();
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("SharePoint token base URL must be absolute");
    }

    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/u, "");
}

function requireNonEmptyString(value: string, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`SharePoint ${name} is required`);
    }

    return value.trim();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function requireDriveItemId(item: SharePointDriveItem): string {
    if (typeof item.id !== "string" || item.id.length === 0) {
        throw new ConnectorProviderError("provider", "SharePoint item did not include an id");
    }

    return item.id;
}

function driveItemName(item: SharePointDriveItem, path: string): string {
    if (typeof item.name === "string" && item.name.trim().length > 0) {
        return item.name.trim();
    }

    const segments = normalizeSharePointFolderPath(path).split("/").filter(Boolean);
    return segments.at(-1) ?? "SharePoint files";
}

function assertSharePointFolder(item: SharePointDriveItem, message: string): void {
    if (!isSharePointFolder(item)) {
        throw new ConnectorProviderError("validation", message);
    }
}

function assertSharePointFile(item: SharePointDriveItem, message: string): void {
    if (!isSharePointFile(item)) {
        throw new ConnectorProviderError("validation", message);
    }
}

function isSharePointFolder(item: SharePointDriveItem): boolean {
    return isPlainRecord(item.folder);
}

function isSharePointFile(item: SharePointDriveItem): boolean {
    return isPlainRecord(item.file);
}

function isDeletedDriveItem(item: SharePointDriveItem): boolean {
    return item.deleted !== undefined;
}

function optionalMimeType(value: unknown): string | undefined {
    if (!isPlainRecord(value) || typeof value.mimeType !== "string") {
        return undefined;
    }

    return value.mimeType;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFromValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function isVersionedSharePointPayload(
    value: unknown,
    subject: "app" | "installation"
): value is VersionedConnectorCredentialPayload<typeof subject, typeof SHAREPOINT_PROVIDER> {
    if (!isPlainRecord(value)) {
        return false;
    }

    return (
        value.provider === SHAREPOINT_PROVIDER &&
        value.subject === subject &&
        value.version === SHAREPOINT_CREDENTIAL_VERSION
    );
}

function hasNonEmptyString(value: Record<string, unknown>, key: string): boolean {
    return typeof value[key] === "string" && (value[key] as string).trim().length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toConnectorProviderError(cause: unknown): ConnectorProviderError {
    if (cause instanceof ConnectorProviderError) {
        return cause;
    }

    return new ConnectorProviderError("provider", "SharePoint provider request failed", { cause });
}
