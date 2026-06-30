import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type SyncProvider = string;

export type SyncResourceKind = string;

export type SyncStatus = "pending" | "syncing" | "synced" | "failed";

export type SyncTriggerReason = "initial" | "webhook" | "manual";

export type SyncResourceCapabilities = {
    readonly versions: boolean;
    readonly cursorSync: boolean;
    readonly children: boolean;
    readonly binaryFiles: boolean;
};

export type SyncTarget = {
    readonly provider: SyncProvider;
    readonly resourceKind: SyncResourceKind;
    readonly resourceId: string;
    readonly providerResourceId: string;
    readonly resourceDisplayName: string;
    readonly resourceWebUrl: string;
    readonly versionName?: string | null;
    readonly versionId?: string | null;
    readonly syncCursor?: string | null;
    readonly metadata?: unknown;
};

export type SyncBinding = {
    readonly id: string;
    readonly graphId: string;
    readonly provider: SyncProvider;
    readonly resourceKind: SyncResourceKind;
    readonly providerResourceId: string;
    readonly resourceDisplayName: string;
    readonly resourceWebUrl: string;
    readonly versionName?: string | null;
    readonly lastSeenVersionId: string | null;
    readonly lastSyncedVersionId: string | null;
    readonly syncCursor: string | null;
    readonly metadata: unknown | null;
    readonly syncEnabled: boolean;
    readonly webhookEnabled: boolean;
};

export type SyncTrigger = {
    readonly reason: SyncTriggerReason;
    readonly versionId?: string;
    readonly cursor?: string;
    readonly deliveryId?: string;
};

export type SyncedExternalItemContentAccessMode = "text" | "binary" | "external" | "unavailable";

export type SyncedExternalItemProcessingKind = "code" | "document" | "media";

export type SyncedExternalItem = {
    readonly providerItemId: string;
    readonly parentProviderItemId?: string | null;
    readonly path?: string;
    readonly displayName: string;
    readonly mimeType?: string;
    readonly contentType?: string;
    readonly size?: number;
    readonly checksum?: string;
    readonly etag?: string;
    readonly webUrl?: string;
    readonly rawUrl?: string;
    readonly versionName?: string;
    readonly defaultBranch?: string;
    readonly versionId?: string;
    readonly contentAccessMode: SyncedExternalItemContentAccessMode;
    readonly processingKind: SyncedExternalItemProcessingKind;
    readonly textContent?: string;
    readonly metadata?: unknown;
};

export type SyncedExternalItemChange =
    | {
          readonly status: "added" | "modified";
          readonly providerItemId?: string;
          readonly path?: string;
          readonly item?: SyncedExternalItem;
      }
    | {
          readonly status: "deleted";
          readonly providerItemId?: string;
          readonly path?: string;
      }
    | {
          readonly status: "renamed";
          readonly providerItemId?: string;
          readonly oldPath?: string;
          readonly path?: string;
          readonly item?: SyncedExternalItem;
      };

export type SyncSnapshot = {
    readonly resourceId: string;
    readonly versionName?: string;
    readonly defaultBranch?: string;
    readonly versionId?: string;
    readonly cursor?: string;
    readonly items: readonly SyncedExternalItem[];
};

export type SyncDelta = {
    readonly isIncremental: boolean;
    readonly fromVersionId?: string;
    readonly toVersionId?: string;
    readonly cursor?: string;
    readonly changes: readonly SyncedExternalItemChange[];
};

export type SyncStrategyKind = "versioned-resource" | "cursor" | "hierarchical-snapshot" | "binary-document";

export type SyncStrategyError = UnsupportedSyncStrategyError;

export type VersionedResourceSyncStrategy<E = SyncStrategyError> = {
    readonly kind: "versioned-resource";
    resolveTargetVersion(target: SyncTarget, inputVersionId?: string): Effect.Effect<string, E>;
    loadSnapshot(target: SyncTarget, versionId: string): Effect.Effect<SyncSnapshot, E>;
    compareVersions(target: SyncTarget, fromVersionId: string, toVersionId: string): Effect.Effect<SyncDelta, E>;
    readChangedItems(
        target: SyncTarget,
        versionId: string,
        paths: readonly string[]
    ): Effect.Effect<readonly SyncedExternalItem[], E>;
};

export type CursorSyncStrategy<E = SyncStrategyError> = {
    readonly kind: "cursor";
    listChanges(target: SyncTarget, cursor?: string | null): Effect.Effect<SyncDelta, E>;
};

export type HierarchicalSnapshotStrategy<E = SyncStrategyError> = {
    readonly kind: "hierarchical-snapshot";
    loadSnapshot(target: SyncTarget, parentProviderItemId?: string | null): Effect.Effect<SyncSnapshot, E>;
};

export type BinaryDocumentStrategy<E = SyncStrategyError> = {
    readonly kind: "binary-document";
    openItem(
        target: SyncTarget,
        item: SyncedExternalItem
    ): Effect.Effect<
        {
            readonly bytes: Uint8Array;
            readonly contentType?: string;
            readonly size?: number;
        },
        E
    >;
};

export type SyncStrategy<E = SyncStrategyError> =
    | VersionedResourceSyncStrategy<E>
    | CursorSyncStrategy<E>
    | HierarchicalSnapshotStrategy<E>
    | BinaryDocumentStrategy<E>;
const SYNC_STRATEGY_KINDS = [
    "versioned-resource",
    "cursor",
    "hierarchical-snapshot",
    "binary-document",
    "unknown",
] as const;
const SYNC_CAPABILITY_KEYS = ["versions", "cursorSync", "children", "binaryFiles"] as const;

export class UnsupportedSyncStrategyError extends Schema.TaggedErrorClass<UnsupportedSyncStrategyError>()(
    "UnsupportedSyncStrategyError",
    {
        strategy: Schema.Literals(SYNC_STRATEGY_KINDS),
        message: Schema.String,
        capability: Schema.optional(Schema.Literals(SYNC_CAPABILITY_KEYS)),
    }
) {
    constructor(options: {
        readonly strategy: SyncStrategyKind | "unknown";
        readonly message: string;
        readonly capability?: keyof SyncResourceCapabilities;
    }) {
        super(
            options.capability === undefined
                ? { strategy: options.strategy, message: options.message }
                : { strategy: options.strategy, message: options.message, capability: options.capability }
        );
    }
}
