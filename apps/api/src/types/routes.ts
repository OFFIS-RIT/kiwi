import type { ApiResponse } from "./responses";

export type GroupUserRole = "admin" | "user" | "moderator";
export type GraphState = "ready" | "updating";

export type GroupUserRecord = {
    groupId: string;
    userId: string;
    role: GroupUserRole;
    createdAt: Date | null;
    updatedAt: Date | null;
};

export type GroupRecord = {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
};

export type GraphRecord = {
    id: string;
    name: string;
    description: string | null;
    groupId: string | null;
    userId: string | null;
    graphId: string | null;
    hidden: boolean;
    state: GraphState;
};

export type GraphFileRecord = {
    id: string;
    name: string;
    type: string;
    mimeType: string;
    size: number;
    key: string;
};

export type GraphDetailFileRecord = {
    id: string;
    project_id: string;
    name: string;
    file_key: string;
    created_at: string | null;
    updated_at: string | null;
};

export type ApiBatchStepProgressLike = {
    pending?: string;
    preprocessing?: string;
    metadata?: string;
    chunking?: string;
    extracting?: string;
    deduplicating?: string;
    saving?: string;
    describing?: string;
    completed?: string;
    failed?: string;
};

export type GroupListItem = {
    group_id: string;
    group_name: string;
    role: GroupUserRole;
};

export type GroupUserListItem = {
    group_id: string;
    user_id: string;
    role: GroupUserRole;
    created_at: string | null;
    updated_at: string | null;
};

export type GraphListItem = {
    graph_id: string;
    graph_name: string;
    graph_state: "ready" | "update";
    group_id: string;
    hidden: boolean;
    process_step?: ApiBatchStepProgressLike;
    process_percentage?: number;
    process_estimated_duration?: number;
    process_time_remaining?: number;
    process_eta_confidence?: "low" | "medium" | "high";
    process_eta_sample_count?: number;
};

export type GraphFileListItem = {
    id: string;
    project_id: string;
    name: string;
    file_key: string;
    created_at: string | null;
    updated_at: string | null;
};

export type TextUnitRecord = {
    id: string;
    project_file_id: string;
    text: string;
    created_at: string | null;
    updated_at: string | null;
};

export type DeleteS3Cleanup = {
    attemptedKeyCount: number;
    failedKeyCount: number;
};

export type GroupCreateSuccessData = {
    group: Pick<GroupRecord, "id">;
    users: GroupUserRecord[];
};

export type GroupPatchSuccessData = {
    group: GroupRecord;
    users: GroupUserRecord[];
};

export type GroupDeleteSuccessData = {
    groupId: string;
    deletedGraphCount: number;
    deletedFileCount: number;
    s3Cleanup: DeleteS3Cleanup;
    warnings?: string[];
};

export type GraphDetailSuccessData = {
    project_id: string;
    project_name: string;
    project_state: "ready" | "update";
    description: string | null;
    hidden: boolean;
    group_id: string | null;
    group_name: string | null;
    files: GraphDetailFileRecord[];
};

export type GraphCreateSuccessData = {
    graph: GraphRecord;
    files: GraphFileRecord[];
    workflowRunId: string | null;
};

export type GraphPatchSuccessData = {
    graph: GraphRecord;
};

export type GraphAddFilesSuccessData = {
    graph: GraphRecord;
    addedFiles: GraphFileRecord[];
    workflowRunId: string | null;
};

export type GraphDeleteFilesSuccessData = {
    graph: GraphRecord;
    removedFileKeys: string[];
    workflowRunId: string | null;
};

export type GraphFileDownloadSuccessData = {
    url: string;
};

export type GraphDeleteSuccessData = {
    graphId: string;
    deletedGraphCount: number;
    deletedFileCount: number;
    s3Cleanup: DeleteS3Cleanup;
    warnings?: string[];
};

export type GroupCreateResponse = ApiResponse<
    GroupCreateSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;

export type GroupListResponse = ApiResponse<GroupListItem[], "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR">;

export type GroupUsersResponse = ApiResponse<
    GroupUserListItem[],
    "UNAUTHORIZED" | "FORBIDDEN" | "GROUP_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type GroupPatchResponse = ApiResponse<
    GroupPatchSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "GROUP_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type GroupDeleteResponse = ApiResponse<
    GroupDeleteSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "GROUP_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type GraphDetailResponse = ApiResponse<
    GraphDetailSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphListResponse = ApiResponse<GraphListItem[], "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR">;

export type GraphFilesResponse = ApiResponse<
    GraphFileListItem[],
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphCreateResponse = ApiResponse<
    GraphCreateSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphPatchResponse = ApiResponse<
    GraphPatchSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_NAME"
    | "NO_CHANGES"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphAddFilesResponse = ApiResponse<
    GraphAddFilesSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "NO_CHANGES"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphDeleteFilesResponse = ApiResponse<
    GraphDeleteFilesSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_FILE_IDS"
    | "NO_CHANGES"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphFileDownloadResponse = ApiResponse<
    GraphFileDownloadSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_FILE_IDS"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphDeleteResponse = ApiResponse<
    GraphDeleteSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INTERNAL_SERVER_ERROR"
>;

export type TextUnitResponse = ApiResponse<
    TextUnitRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GROUP_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "TEXT_UNIT_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;
