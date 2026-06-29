import { Schema } from "effect";
import type { ApiResponse } from "./errors";
import {
    type MutableSchemaType,
    NonEmptyTrimmedStringSchema,
    OptionalNonEmptyTrimmedStringSchema,
    UrlStringSchema,
} from "./schema";
import type { GraphRecord } from "./graphs";

export type ConnectorProvider = string;
export type ConnectorStatus = "draft" | "active" | "disabled";
export type ConnectorInstallationStatus = "active" | "disabled" | "pending";
export type ConnectorInstallationSubjectKind = "user" | "team" | "organization";
export type ConnectorAccountType = "user" | "organization" | "group" | null;
export type ConnectorRepositorySelection = "all" | "selected" | "unknown";
export type ConnectorResourceKind = string;
export type ConnectorResourceGraphBindingSyncStatus = "pending" | "syncing" | "synced" | "failed";
export type RepositoryGraphBindingSyncStatus = ConnectorResourceGraphBindingSyncStatus;

export const ConnectorProviderSchema = NonEmptyTrimmedStringSchema;
export const ConnectorInstallationSubjectKindSchema = Schema.Literals(["user", "team", "organization"] as const);
export const ConnectorResourceKindSchema = NonEmptyTrimmedStringSchema;
const NullableStringSchema = Schema.Union([Schema.String, Schema.Null]);

export type ConnectorRecord = {
    id: string;
    provider: ConnectorProvider;
    name: string;
    slug: string;
    status: ConnectorStatus;
    appId: string | null;
    clientId: string | null;
    createdAt: string;
    updatedAt: string;
};

export type ConnectorInstallationRecord = {
    id: string;
    connectorId: string;
    provider: ConnectorProvider;
    providerInstallationId: string;
    providerAccountLogin: string;
    providerAccountType: ConnectorAccountType;
    subjectKind: ConnectorInstallationSubjectKind;
    subjectUserId: string | null;
    subjectTeamId: string | null;
    subjectOrganizationId: string | null;
    installedByUserId: string | null;
    organizationId: string | null;
    teamId: string | null;
    repositorySelection: ConnectorRepositorySelection;
    status: ConnectorInstallationStatus;
    createdAt: string;
    updatedAt: string;
};

export const ConnectorResourceRecordSchema = Schema.Struct({
    provider: ConnectorProviderSchema,
    resourceKind: ConnectorResourceKindSchema,
    resourceId: NonEmptyTrimmedStringSchema,
    providerResourceId: OptionalNonEmptyTrimmedStringSchema,
    resourceDisplayName: NonEmptyTrimmedStringSchema,
    resourceWebUrl: UrlStringSchema,
    defaultVersionName: OptionalNonEmptyTrimmedStringSchema,
    defaultVersionId: OptionalNonEmptyTrimmedStringSchema,
    metadata: Schema.optional(Schema.Unknown),
    id: OptionalNonEmptyTrimmedStringSchema,
    fullName: OptionalNonEmptyTrimmedStringSchema,
    name: OptionalNonEmptyTrimmedStringSchema,
    htmlUrl: Schema.optional(UrlStringSchema),
    defaultBranch: Schema.optional(NullableStringSchema),
    private: Schema.optional(Schema.Boolean),
    displayName: OptionalNonEmptyTrimmedStringSchema,
    webUrl: Schema.optional(UrlStringSchema),
});
export type ConnectorResourceRecord = MutableSchemaType<Schema.Schema.Type<typeof ConnectorResourceRecordSchema>>;

export const ConnectorRepositoryRecordSchema = ConnectorResourceRecordSchema;
export type ConnectorRepositoryRecord = ConnectorResourceRecord;

export const ConnectorResourceVersionRecordSchema = Schema.Struct({
    versionName: NonEmptyTrimmedStringSchema,
    versionId: OptionalNonEmptyTrimmedStringSchema,
    resourceId: OptionalNonEmptyTrimmedStringSchema,
    syncCursor: OptionalNonEmptyTrimmedStringSchema,
    metadata: Schema.optional(Schema.Unknown),
    name: OptionalNonEmptyTrimmedStringSchema,
    commitSha: OptionalNonEmptyTrimmedStringSchema,
});
export type ConnectorResourceVersionRecord = MutableSchemaType<
    Schema.Schema.Type<typeof ConnectorResourceVersionRecordSchema>
>;

export const ConnectorBranchRecordSchema = ConnectorResourceVersionRecordSchema;
export type ConnectorBranchRecord = ConnectorResourceVersionRecord;

export type ConnectorResourceGraphBindingRecord = {
    id: string;
    graphId: string;
    connectorInstallationId: string;
    provider: ConnectorProvider;
    resourceKind: ConnectorResourceKind;
    resourceId: string;
    providerResourceId: string;
    resourceDisplayName: string;
    resourceWebUrl: string;
    versionName: string | null;
    versionId: string | null;
    lastSeenVersionId: string | null;
    lastSyncedVersionId: string | null;
    syncCursor: string | null;
    metadata: unknown | null;
    syncStatus: ConnectorResourceGraphBindingSyncStatus;
    syncErrorCode: string | null;
    syncEnabled: boolean;
    webhookEnabled: boolean;
    providerRepositoryId?: string;
    repositoryFullName?: string;
    repositoryHtmlUrl?: string;
    branch?: string;
    lastSeenCommitSha?: string | null;
    lastSyncedCommitSha?: string | null;
    createdAt: string | null;
    updatedAt: string | null;
};
export type RepositoryGraphBindingRecord = ConnectorResourceGraphBindingRecord;

export const GitHubConnectorManifestStartInputSchema = Schema.Struct({
    name: NonEmptyTrimmedStringSchema,
});
export type GitHubConnectorManifestStartInput = MutableSchemaType<
    Schema.Schema.Type<typeof GitHubConnectorManifestStartInputSchema>
>;

export const GitHubManifestCallbackQuerySchema = Schema.Struct({
    code: NonEmptyTrimmedStringSchema,
    state: NonEmptyTrimmedStringSchema,
});
export type GitHubManifestCallbackQuery = MutableSchemaType<
    Schema.Schema.Type<typeof GitHubManifestCallbackQuerySchema>
>;

export type GitHubConnectorManifestStartSuccessData = {
    manifestUrl: string;
    state: string;
};

export type ConnectorConnectStartSuccessData = {
    redirectUrl: string;
};

export const GitLabConnectorCreateInputSchema = Schema.Struct({
    name: NonEmptyTrimmedStringSchema,
    slug: NonEmptyTrimmedStringSchema,
    baseUrl: UrlStringSchema,
    clientId: NonEmptyTrimmedStringSchema,
    clientSecret: NonEmptyTrimmedStringSchema,
    webhookSecret: NonEmptyTrimmedStringSchema,
});
export type GitLabConnectorCreateInput = MutableSchemaType<Schema.Schema.Type<typeof GitLabConnectorCreateInputSchema>>;

export const ConnectorPatchInputSchema = Schema.Struct({
    name: OptionalNonEmptyTrimmedStringSchema,
    status: Schema.optional(Schema.Literals(["active", "disabled"] as const)),
    webhookSecret: OptionalNonEmptyTrimmedStringSchema,
});
export type ConnectorPatchInput = MutableSchemaType<Schema.Schema.Type<typeof ConnectorPatchInputSchema>>;

export const ConnectorConnectQuerySchema = Schema.Struct({
    subjectKind: Schema.optional(ConnectorInstallationSubjectKindSchema),
    subjectUserId: OptionalNonEmptyTrimmedStringSchema,
    subjectTeamId: OptionalNonEmptyTrimmedStringSchema,
    subjectOrganizationId: OptionalNonEmptyTrimmedStringSchema,
    organizationId: OptionalNonEmptyTrimmedStringSchema,
    teamId: OptionalNonEmptyTrimmedStringSchema,
});
export type ConnectorConnectQuery = MutableSchemaType<Schema.Schema.Type<typeof ConnectorConnectQuerySchema>>;

export const GitHubInstallCallbackQuerySchema = Schema.Struct({
    state: NonEmptyTrimmedStringSchema,
    installation_id: NonEmptyTrimmedStringSchema,
    setup_action: Schema.optional(Schema.Trim),
});
export type GitHubInstallCallbackQuery = MutableSchemaType<Schema.Schema.Type<typeof GitHubInstallCallbackQuerySchema>>;

export const ConnectorResourceQuerySchema = Schema.Struct({
    installationId: NonEmptyTrimmedStringSchema,
});
export type ConnectorResourceQuery = MutableSchemaType<Schema.Schema.Type<typeof ConnectorResourceQuerySchema>>;

export const ConnectorRepositoryQuerySchema = ConnectorResourceQuerySchema;
export type ConnectorRepositoryQuery = ConnectorResourceQuery;

const UserConnectorOwnerScopeInputSchema = Schema.Struct({
    kind: Schema.Literal("user"),
    userId: NonEmptyTrimmedStringSchema,
});

const TeamConnectorOwnerScopeInputSchema = Schema.Struct({
    kind: Schema.Literal("team"),
    teamId: NonEmptyTrimmedStringSchema,
});

export const ConnectorOwnerScopeInputSchema = Schema.Union([
    Schema.Struct({
        kind: Schema.Literal("organization"),
        organizationId: OptionalNonEmptyTrimmedStringSchema,
    }),
    TeamConnectorOwnerScopeInputSchema,
    UserConnectorOwnerScopeInputSchema,
]);

export const ConnectorBindingCreateInputSchema = Schema.Struct({
    connectorInstallationId: NonEmptyTrimmedStringSchema,
    resourceKind: ConnectorResourceKindSchema,
    resourceId: NonEmptyTrimmedStringSchema,
    resourceDisplayName: NonEmptyTrimmedStringSchema,
    resourceWebUrl: UrlStringSchema,
    versionName: OptionalNonEmptyTrimmedStringSchema,
    versionId: OptionalNonEmptyTrimmedStringSchema,
    syncCursor: OptionalNonEmptyTrimmedStringSchema,
    metadata: Schema.optional(Schema.Unknown),
    syncEnabled: Schema.optional(Schema.Boolean),
    webhookEnabled: Schema.optional(Schema.Boolean),
    name: NonEmptyTrimmedStringSchema,
    owner: ConnectorOwnerScopeInputSchema,
});
export type ConnectorBindingCreateInput = MutableSchemaType<
    Schema.Schema.Type<typeof ConnectorBindingCreateInputSchema>
>;

export const ConnectorResourceGraphCreateInputSchema = Schema.Struct({
    connectorInstallationId: NonEmptyTrimmedStringSchema,
    resourceKind: ConnectorResourceKindSchema,
    resourceId: NonEmptyTrimmedStringSchema,
    resourceDisplayName: NonEmptyTrimmedStringSchema,
    resourceWebUrl: UrlStringSchema,
    versionName: OptionalNonEmptyTrimmedStringSchema,
    versionId: OptionalNonEmptyTrimmedStringSchema,
    syncCursor: OptionalNonEmptyTrimmedStringSchema,
    metadata: Schema.optional(Schema.Unknown),
    syncEnabled: Schema.optional(Schema.Boolean),
    webhookEnabled: Schema.optional(Schema.Boolean),
    name: NonEmptyTrimmedStringSchema,
    owner: ConnectorOwnerScopeInputSchema,
});
export type ConnectorResourceGraphCreateInput = MutableSchemaType<
    Schema.Schema.Type<typeof ConnectorResourceGraphCreateInputSchema>
>;

export const RepositoryGraphCreateInputSchema = Schema.Struct({
    connectorInstallationId: NonEmptyTrimmedStringSchema,
    repositoryId: NonEmptyTrimmedStringSchema,
    repositoryFullName: NonEmptyTrimmedStringSchema,
    repositoryHtmlUrl: UrlStringSchema,
    branch: NonEmptyTrimmedStringSchema,
    resourceKind: Schema.optional(ConnectorResourceKindSchema),
    resourceId: OptionalNonEmptyTrimmedStringSchema,
    resourceDisplayName: OptionalNonEmptyTrimmedStringSchema,
    resourceWebUrl: Schema.optional(UrlStringSchema),
    versionName: OptionalNonEmptyTrimmedStringSchema,
    versionId: OptionalNonEmptyTrimmedStringSchema,
    syncCursor: OptionalNonEmptyTrimmedStringSchema,
    metadata: Schema.optional(Schema.Unknown),
    syncEnabled: Schema.optional(Schema.Boolean),
    webhookEnabled: Schema.optional(Schema.Boolean),
    name: NonEmptyTrimmedStringSchema,
    owner: ConnectorOwnerScopeInputSchema,
});
export type RepositoryGraphCreateInput = MutableSchemaType<Schema.Schema.Type<typeof RepositoryGraphCreateInputSchema>>;

export type ConnectorResourceGraphCreateSuccessData = {
    graph: GraphRecord;
    binding: ConnectorResourceGraphBindingRecord;
    workflowRunId: string | null;
};
export type RepositoryGraphCreateSuccessData = ConnectorResourceGraphCreateSuccessData;

export type ConnectorResourceGraphBindingSyncSuccessData = {
    binding: ConnectorResourceGraphBindingRecord;
    workflowRunId: string | null;
};
export type RepositoryGraphBindingSyncSuccessData = ConnectorResourceGraphBindingSyncSuccessData;

export type ConnectorListResponse = ApiResponse<
    ConnectorRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;

export type ConnectorConnectStartResponse = ApiResponse<
    ConnectorConnectStartSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
>;
export type GitHubConnectorManifestStartResponse = ApiResponse<
    GitHubConnectorManifestStartSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_NAME" | "INTERNAL_SERVER_ERROR"
>;
export type GitLabConnectorCreateResponse = ApiResponse<
    ConnectorRecord,
    "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_NAME" | "INTERNAL_SERVER_ERROR"
>;
export type ConnectorInstallationListResponse = ApiResponse<
    ConnectorInstallationRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;
export type ConnectorResourceListResponse = ApiResponse<
    ConnectorResourceRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;
export type ConnectorResourceVersionListResponse = ApiResponse<
    ConnectorResourceVersionRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;
export type ConnectorRepositoryListResponse = ConnectorResourceListResponse;
export type ConnectorBranchListResponse = ConnectorResourceVersionListResponse;
export type ConnectorResourceGraphCreateResponse = ApiResponse<
    ConnectorResourceGraphCreateSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INVALID_NAME" | "INTERNAL_SERVER_ERROR"
>;
export type RepositoryGraphCreateResponse = ConnectorResourceGraphCreateResponse;
export type ConnectorResourceGraphBindingResponse = ApiResponse<
    ConnectorResourceGraphBindingRecord,
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
>;
export type RepositoryGraphBindingResponse = ConnectorResourceGraphBindingResponse;
export type ConnectorResourceGraphBindingSyncResponse = ApiResponse<
    ConnectorResourceGraphBindingSyncSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
>;
export type RepositoryGraphBindingSyncResponse = ConnectorResourceGraphBindingSyncResponse;
