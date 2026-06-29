import * as Effect from "effect/Effect";

import type {
    ConnectorAdapter,
    ConnectorAdapterFactoryOptions,
    ConnectorAdapterRegistryEntry,
    ConnectorCredentialDescriptor,
    ConnectorCredentialPayloadData,
    ConnectorCredentials,
    ConnectorFileLocator,
    ConnectorInstallationCredentials,
    ConnectorProvider,
    ConnectorResource,
    ConnectorResourceCapabilities,
    ConnectorResourceChild,
    ConnectorResourceVersion,
} from "./types";
import { ConnectorProviderError } from "./types";

export const IN_MEMORY_RESOURCE_PROVIDER = "in-memory-resource";

export const IN_MEMORY_RESOURCE_CAPABILITIES: ConnectorResourceCapabilities = {
    versions: false,
    cursorSync: true,
    children: true,
    binaryFiles: true,
};

type InMemoryCredentialDescriptors = {
    app: ConnectorCredentialDescriptor<"app">;
    installation: ConnectorCredentialDescriptor<"installation">;
};

export const inMemoryResourceCredentialDescriptors: InMemoryCredentialDescriptors = {
    app: {
        subject: "app",
        version: "v1",
        validate(data) {
            return data.fixture === undefined || typeof data.fixture === "string";
        },
    },
    installation: {
        subject: "installation",
        version: "v1",
        validate(data) {
            return typeof data.accountId === "string" && data.accountId.trim().length > 0;
        },
    },
};

export type InMemoryResourceFile = {
    id: string;
    resourceId: string;
    parentId: string | null;
    path: string;
    displayName: string;
    contentAccessMode: "text" | "binary" | "external" | "unavailable";
    processingKind: "code" | "document" | "media";
    mimeType?: string;
    contentType?: string;
    text?: string;
    bytes?: Uint8Array;
    checksum?: string;
    etag?: string;
    webUrl?: string;
};

export type InMemoryResourceAdapterOptions = {
    provider?: ConnectorProvider;
    resources?: readonly ConnectorResource[];
    files?: readonly InMemoryResourceFile[];
};

const DEFAULT_RESOURCE: ConnectorResource = {
    provider: IN_MEMORY_RESOURCE_PROVIDER,
    kind: "folder",
    id: "drive:fixture",
    displayName: "Fixture Drive",
    webUrl: "memory://fixture-drive",
    private: true,
};

const DEFAULT_FILES: readonly InMemoryResourceFile[] = [
    {
        id: "folder:docs",
        resourceId: DEFAULT_RESOURCE.id,
        parentId: null,
        path: "docs",
        displayName: "docs",
        contentAccessMode: "unavailable",
        processingKind: "document",
        mimeType: "application/vnd.kiwi.folder",
        webUrl: "memory://fixture-drive/docs",
    },
    {
        id: "file:docs/readme.txt",
        resourceId: DEFAULT_RESOURCE.id,
        parentId: "folder:docs",
        path: "docs/readme.txt",
        displayName: "readme.txt",
        contentAccessMode: "text",
        processingKind: "document",
        mimeType: "text/plain",
        contentType: "text/plain; charset=utf-8",
        text: "hello from the in-memory connector",
        checksum: "sha256:fixture-readme",
        etag: "etag-readme",
        webUrl: "memory://fixture-drive/docs/readme.txt",
    },
    {
        id: "file:docs/manual.pdf",
        resourceId: DEFAULT_RESOURCE.id,
        parentId: "folder:docs",
        path: "docs/manual.pdf",
        displayName: "manual.pdf",
        contentAccessMode: "binary",
        processingKind: "document",
        mimeType: "application/pdf",
        contentType: "application/pdf",
        bytes: new Uint8Array([37, 80, 68, 70]),
        checksum: "sha256:fixture-pdf",
        etag: "etag-pdf",
        webUrl: "memory://fixture-drive/docs/manual.pdf",
    },
];

export const inMemoryResourceConnectorRegistryEntry: ConnectorAdapterRegistryEntry = {
    provider: IN_MEMORY_RESOURCE_PROVIDER,
    family: "resource-source",
    display: {
        name: "In-memory resource fixture",
        description: "Non-git resource-source fixture for registry and cursor-sync integration tests.",
    },
    resourceKind: "folder",
    capabilities: IN_MEMORY_RESOURCE_CAPABILITIES,
    setup: [
        {
            kind: "none",
            label: "Fixture app",
            description: "No external app registration is required.",
        },
    ],
    install: [
        {
            kind: "manualActivation",
            label: "Activate fixture",
            description: "Attach the fixture account to the installation.",
        },
    ],
    credentialDescriptors: inMemoryResourceCredentialDescriptors,
    create: Effect.fn("InMemoryResourceRegistry.create")(function* (options: ConnectorAdapterFactoryOptions) {
        if (
            !isCredentialPayloadValid(options.credentials, inMemoryResourceCredentialDescriptors.app) ||
            !isCredentialPayloadValid(options.installation, inMemoryResourceCredentialDescriptors.installation)
        ) {
            return yield* Effect.fail(
                new ConnectorProviderError("validation", "In-memory resource credentials are invalid")
            );
        }
        return createInMemoryResourceAdapter({ provider: options.provider });
    }),
};

export function createInMemoryResourceAdapter(options: InMemoryResourceAdapterOptions = {}): ConnectorAdapter {
    const provider = options.provider ?? IN_MEMORY_RESOURCE_PROVIDER;
    const resources = options.resources ?? [{ ...DEFAULT_RESOURCE, provider }];
    const files = options.files ?? DEFAULT_FILES;

    return {
        provider,
        resourceKind: "folder",
        capabilities: IN_MEMORY_RESOURCE_CAPABILITIES,
        getResource: Effect.fn("InMemoryResourceAdapter.getResource")(function* (resourceId: string) {
            const resource = resources.find((candidate) => candidate.id === resourceId);
            if (!resource) {
                return yield* Effect.fail(new ConnectorProviderError("not-found", "In-memory resource was not found"));
            }
            return resource;
        }),
        listResources: Effect.fn("InMemoryResourceAdapter.listResources")(function* () {
            return [...resources];
        }),
        listResourceVersions: Effect.fn("InMemoryResourceAdapter.listResourceVersions")(function* () {
            return [] satisfies ConnectorResourceVersion[];
        }),
        loadSnapshot: Effect.fn("InMemoryResourceAdapter.loadSnapshot")(function* (resourceId: string) {
            const resource = yield* findResource(resources, resourceId);
            return {
                resource,
                version: { resourceId, name: "cursor", versionId: "cursor" },
                files: files
                    .filter((file) => file.resourceId === resourceId && file.text !== undefined)
                    .map((file) => ({
                        path: file.path,
                        size: file.text?.length ?? 0,
                        checksum: file.checksum ?? file.etag ?? file.id,
                        htmlUrl: file.webUrl ?? resource.webUrl,
                        content: file.text ?? "",
                    })),
            };
        }),
        compareVersions: Effect.fn("InMemoryResourceAdapter.compareVersions")(function* () {
            return yield* Effect.fail(
                new ConnectorProviderError("validation", "In-memory resources use cursor sync instead of versions")
            );
        }),
        readFile: Effect.fn("InMemoryResourceAdapter.readFile")(function* (locator: ConnectorFileLocator) {
            const file = yield* findFile(files, locator);
            if (file.text === undefined) {
                return yield* Effect.fail(
                    new ConnectorProviderError("validation", "In-memory file is not text-readable")
                );
            }
            return file.text;
        }),
        listChildren: Effect.fn("InMemoryResourceAdapter.listChildren")(function* (parentId?: string) {
            return files.filter((file) => file.parentId === (parentId ?? null)).map(mapFileToChild);
        }),
        listChanges: Effect.fn("InMemoryResourceAdapter.listChanges")(function* (resourceId: string, cursor?: string) {
            yield* findResource(resources, resourceId);
            const changes = cursor
                ? []
                : files
                      .filter((file) => file.resourceId === resourceId && file.contentAccessMode !== "unavailable")
                      .map((file) => ({
                          status: "added" as const,
                          newPath: file.path,
                          providerItemId: file.id,
                          ...(file.etag ? { etag: file.etag } : {}),
                      }));
            return { changes, cursor: "cursor:fixture:1", isInitial: cursor === undefined };
        }),
        openFile: Effect.fn("InMemoryResourceAdapter.openFile")(function* (locator: ConnectorFileLocator) {
            const file = yield* findFile(files, locator);
            const bytes = file.bytes ?? (file.text === undefined ? undefined : new TextEncoder().encode(file.text));
            if (!bytes) {
                return yield* Effect.fail(new ConnectorProviderError("validation", "In-memory file has no bytes"));
            }
            return { locator, bytes, size: bytes.byteLength, contentType: file.contentType ?? file.mimeType };
        }),
    };
}

const findResource = Effect.fn("InMemoryResourceAdapter.findResource")(function* (
    resources: readonly ConnectorResource[],
    resourceId: string
) {
    const resource = resources.find((candidate) => candidate.id === resourceId);
    if (!resource) {
        return yield* Effect.fail(new ConnectorProviderError("not-found", "In-memory resource was not found"));
    }
    return resource;
});

const findFile = Effect.fn("InMemoryResourceAdapter.findFile")(function* (
    files: readonly InMemoryResourceFile[],
    locator: ConnectorFileLocator
) {
    const file = files.find(
        (candidate) => candidate.resourceId === locator.resourceId && candidate.path === locator.path
    );
    if (!file) {
        return yield* Effect.fail(new ConnectorProviderError("not-found", "In-memory file was not found"));
    }
    return file;
});

function mapFileToChild(file: InMemoryResourceFile): ConnectorResourceChild {
    const kind = file.contentAccessMode === "unavailable" ? "folder" : "file";
    return {
        id: file.id,
        parentId: file.parentId,
        name: file.displayName,
        path: file.path,
        kind,
        webUrl: file.webUrl,
        size: file.bytes?.byteLength ?? file.text?.length,
        versionId: file.etag,
    };
}

function isCredentialPayloadValid(
    value: ConnectorCredentials | ConnectorInstallationCredentials,
    descriptor: ConnectorCredentialDescriptor
): boolean {
    if (!isObject(value)) {
        return false;
    }
    if (
        value.provider === IN_MEMORY_RESOURCE_PROVIDER &&
        value.subject === descriptor.subject &&
        value.version === descriptor.version &&
        isObject(value.data)
    ) {
        return descriptor.validate(value.data);
    }
    return value.provider === IN_MEMORY_RESOURCE_PROVIDER && descriptor.validate(value);
}

function isObject(value: unknown): value is ConnectorCredentialPayloadData {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
