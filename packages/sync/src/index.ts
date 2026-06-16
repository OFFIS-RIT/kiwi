export type SyncProvider = "github" | "gitlab" | (string & {});

export type SyncResourceKind = "git-repository" | (string & {});

export type SyncStatus = "pending" | "syncing" | "synced" | "failed";

export type SyncTriggerReason = "initial" | "webhook" | "manual";

export type SyncBinding = {
    id: string;
    graphId: string;
    provider: SyncProvider;
    resourceKind: SyncResourceKind;
    providerResourceId: string;
    displayName: string;
    webUrl: string;
    versionName: string;
    lastSeenVersionId: string | null;
    lastSyncedVersionId: string | null;
    syncCursor: string | null;
    metadata: unknown | null;
    webhookEnabled: boolean;
};

export type SyncTrigger = {
    reason: SyncTriggerReason;
    versionId?: string;
    cursor?: string;
    deliveryId?: string;
};

export type SyncFile = {
    path: string;
    displayName: string;
    providerFileId: string;
    versionId: string;
    checksum: string;
    size: number;
    content: string;
    webUrl?: string;
    rawUrl?: string;
};

export type SyncSnapshot = {
    versionId: string;
    cursor?: string;
    files: SyncFile[];
};

export type SyncFileChange =
    | {
          status: "added" | "modified";
          file: SyncFile;
      }
    | {
          status: "deleted";
          path: string;
          providerFileId?: string;
          versionId?: string;
      }
    | {
          status: "renamed";
          oldPath: string;
          file: SyncFile;
      };

export type SyncDelta = {
    isIncremental: boolean;
    fromVersionId?: string;
    toVersionId: string;
    cursor?: string;
    changes: SyncFileChange[];
};
