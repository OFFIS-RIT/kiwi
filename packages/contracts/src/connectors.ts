import { Schema } from "effect";
import type { ApiResponse } from "./errors";
import {
    type MutableSchemaType,
    NonEmptyTrimmedStringSchema,
    OptionalNonEmptyTrimmedStringSchema,
    UrlStringSchema,
} from "./schema";
import type { GraphRecord } from "./graphs";

export type ConnectorProvider = "github" | "gitlab";
export type ConnectorStatus = "draft" | "active" | "disabled";
export type ConnectorInstallationStatus = "active" | "disabled" | "pending";
export type ConnectorAccountType = "user" | "organization" | "group" | null;
export type ConnectorRepositorySelection = "all" | "selected" | "unknown";
export type ConnectorResourceKind = "git-repository" | "folder";
export type ConnectorResourceGraphBindingSyncStatus = "pending" | "syncing" | "synced" | "failed";
export type RepositoryGraphBindingSyncStatus = ConnectorResourceGraphBindingSyncStatus;

export const ConnectorProviderSchema = Schema.Literals(["github", "gitlab"] as const);
export const ConnectorResourceKindSchema = Schema.Literals(["git-repository", "folder"] as const);
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
    organizationId: string | null;
    teamId: string | null;
    repositorySelection: ConnectorRepositorySelection;
    status: ConnectorInstallationStatus;
    createdAt: string;
    updatedAt: string;
};

export const ConnectorResourceRecordSchema = Schema.Struct({
    provider: ConnectorProviderSchema,
    id: NonEmptyTrimmedStringSchema,
    fullName: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    htmlUrl: UrlStringSchema,
    defaultBranch: NullableStringSchema,
    private: Schema.Boolean,
    resourceKind: Schema.optional(ConnectorResourceKindSchema),
    displayName: OptionalNonEmptyTrimmedStringSchema,
    webUrl: Schema.optional(UrlStringSchema),
    defaultVersionName: OptionalNonEmptyTrimmedStringSchema,
    defaultVersionId: OptionalNonEmptyTrimmedStringSchema,
});
export type ConnectorResourceRecord = MutableSchemaType<Schema.Schema.Type<typeof ConnectorResourceRecordSchema>>;

export const ConnectorRepositoryRecordSchema = ConnectorResourceRecordSchema;
export type ConnectorRepositoryRecord = ConnectorResourceRecord;

export const ConnectorResourceVersionRecordSchema = Schema.Struct({
    name: NonEmptyTrimmedStringSchema,
    commitSha: NonEmptyTrimmedStringSchema,
    resourceId: OptionalNonEmptyTrimmedStringSchema,
    versionId: OptionalNonEmptyTrimmedStringSchema,
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
    providerRepositoryId: string;
    repositoryFullName: string;
    repositoryHtmlUrl: string;
    branch: string;
    lastSeenCommitSha: string | null;
    lastSyncedCommitSha: string | null;
    syncStatus: ConnectorResourceGraphBindingSyncStatus;
    syncErrorCode: string | null;
    webhookEnabled: boolean;
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
export type GitHubManifestCallbackQuery = MutableSchemaType<Schema.Schema.Type<typeof GitHubManifestCallbackQuerySchema>>;

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

const TeamConnectorOwnerScopeInputSchema = Schema.Struct({
    kind: Schema.Literal("team"),
    teamId: NonEmptyTrimmedStringSchema,
});

export const ConnectorOwnerScopeInputSchema = Schema.Union([
    Schema.Struct({
        kind: Schema.Literal("organization"),
    }),
    TeamConnectorOwnerScopeInputSchema,
]);
export type ConnectorOwnerScopeInput = MutableSchemaType<Schema.Schema.Type<typeof ConnectorOwnerScopeInputSchema>>;

export const ConnectorBindingCreateInputSchema = Schema.Struct({
    connectorInstallationId: NonEmptyTrimmedStringSchema,
    resourceKind: ConnectorResourceKindSchema,
    resourceId: NonEmptyTrimmedStringSchema,
    resourceDisplayName: NonEmptyTrimmedStringSchema,
    resourceWebUrl: UrlStringSchema,
    versionName: NonEmptyTrimmedStringSchema,
    versionId: NonEmptyTrimmedStringSchema,
    name: NonEmptyTrimmedStringSchema,
    owner: ConnectorOwnerScopeInputSchema,
});
export type ConnectorBindingCreateInput = MutableSchemaType<
    Schema.Schema.Type<typeof ConnectorBindingCreateInputSchema>
>;

export const ConnectorResourceGraphCreateInputSchema = Schema.Struct({
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
    name: NonEmptyTrimmedStringSchema,
    owner: ConnectorOwnerScopeInputSchema,
});
export type ConnectorResourceGraphCreateInput = MutableSchemaType<
    Schema.Schema.Type<typeof ConnectorResourceGraphCreateInputSchema>
>;

export const RepositoryGraphCreateInputSchema = ConnectorResourceGraphCreateInputSchema;
export type RepositoryGraphCreateInput = ConnectorResourceGraphCreateInput;

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

export type ConnectorListResponse = ApiResponse<ConnectorRecord[], "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR">;

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
