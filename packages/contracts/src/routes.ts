import type { ChatUIMessage } from "./chat";
import type { ApiResponse } from "./responses";

export type TeamUserRole = "admin" | "moderator" | "member";
export type GraphState = "ready" | "updating";

export type TeamUserRecord = {
    teamId: string;
    userId: string;
    role: TeamUserRole;
    createdAt: Date | null;
    updatedAt: Date | null;
};

export type TeamRecord = {
    id: string;
    name: string;
    organizationId: string;
    createdAt: Date | null;
    updatedAt: Date | null;
};

export type GraphRecord = {
    id: string;
    name: string;
    description: string | null;
    organizationId: string | null;
    teamId: string | null;
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

export type GraphFileListItem = {
    id: string;
    project_id: string;
    name: string;
    file_key: string;
    status: "processing" | "processed" | "failed";
    process_step:
        | "pending"
        | "preprocessing"
        | "metadata"
        | "chunking"
        | "extracting"
        | "deduplicating"
        | "saving"
        | "completed"
        | "failed";
    created_at: string | null;
    updated_at: string | null;
};

export type GraphDetailFileRecord = GraphFileListItem;

export type ApiBatchStepProgressLike = {
    waiting_worker?: string;
    deleting?: string;
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

export type TeamListItem = {
    team_id: string;
    team_name: string;
    role: TeamUserRole;
};

export type TeamUserListItem = {
    team_id: string;
    user_id: string;
    user_name: string | null;
    role: TeamUserRole;
    created_at: string | null;
    updated_at: string | null;
};

export type OrganizationMemberListItem = {
    user_id: string;
    user_name: string | null;
    user_email: string;
    role: string;
};

export type GraphRecentChatItem = {
    id: string;
    title: string;
    isPinned: boolean;
    updatedAt: string | null;
};

export type GraphListItem = {
    graph_id: string;
    graph_name: string;
    graph_state: "ready" | "update";
    organization_id: string | null;
    team_id: string | null;
    team_name: string | null;
    scope: "organization" | "team" | "private";
    hidden: boolean;
    process_step?: ApiBatchStepProgressLike;
    process_percentage?: number;
    process_estimated_duration?: number;
    process_time_remaining?: number;
    recent_chats: GraphRecentChatItem[];
};

export type TextUnitRecord = {
    id: string;
    project_file_id: string;
    text: string;
    start_page: number | null;
    end_page: number | null;
    file_name: string;
    file_type: string;
    mime_type: string;
    preview: TextUnitPreview;
    created_at: string | null;
    updated_at: string | null;
};

export type TextUnitPreview =
    | {
          type: "pdf_pages";
          start_page: number;
          end_page: number;
          pages: Array<{
              page: number;
              image_path: string;
          }>;
      }
    | {
          type: "none";
      };

export type SourceReferenceUnitRecord = {
    id: string;
    project_file_id: string;
    start_page: number | null;
    end_page: number | null;
    file_name: string;
    file_type: string;
    mime_type: string;
    created_at: string | null;
    updated_at: string | null;
};

export type SourceReferenceChunk =
    | {
          type: "text";
          chunk_id: number;
          text: string;
      }
    | {
          type: "image";
          chunk_id: number;
          image_path: string;
          alt: string;
      };

export type SourceReferencePdfRegionRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export type SourceReferencePdfRegion = {
    kind: "text" | "image" | "page";
    chunk_id: number;
    page: number;
    width: number;
    height: number;
    image_path: string;
    crop: {
        left: number;
        top: number;
        width: number;
        height: number;
    };
    rectangles: SourceReferencePdfRegionRect[];
};

export type SourceReferenceRecord = {
    source_id: string;
    description: string;
    unit: SourceReferenceUnitRecord;
    chunks: SourceReferenceChunk[];
    pdf_regions: SourceReferencePdfRegion[];
};

export type SourceReferenceBatchSuccessData = {
    items: SourceReferenceRecord[];
    missing_source_ids: string[];
};

export type ChatRequestBody =
    | {
          id: string;
          message: ChatUIMessage;
          deep?: boolean;
      }
    | {
          id: string;
          messages: ChatUIMessage[];
          deep?: boolean;
      };

export type ChatSummaryItem = {
    id: string;
    title: string;
    isPinned: boolean;
    updatedAt: string | null;
};

export type ChatListSuccessData = {
    items: ChatSummaryItem[];
    hasMore: boolean;
};

export type SearchProjectItem = {
    id: string;
    name: string;
    scope: "organization" | "team" | "private";
    teamId: string | null;
    teamName: string | null;
};

export type SearchTeamItem = {
    id: string;
    name: string;
};

export type SearchChatItem = {
    id: string;
    title: string;
    isPinned: boolean;
    projectId: string;
    projectName: string;
    scope: "organization" | "team" | "private";
    teamId: string | null;
    teamName: string | null;
};

export type SearchSuccessData = {
    projects: SearchProjectItem[];
    teams: SearchTeamItem[];
    chats: SearchChatItem[];
};

export type PromptRecord = {
    id: string;
    prompt: string;
    created_at: string | null;
    updated_at: string | null;
};

export type ChatHistoryRecord = {
    id: string;
    title: string;
    messages: ChatUIMessage[];
};

export type ChatCreateSuccessData = {
    id: string;
    message: ChatUIMessage;
};

export type DeleteS3Cleanup = {
    attemptedKeyCount: number;
    failedKeyCount: number;
};

export type TeamCreateSuccessData = {
    team: Pick<TeamRecord, "id">;
    users: TeamUserRecord[];
};

export type TeamPatchSuccessData = {
    team: TeamRecord;
    users: TeamUserListItem[];
};

export type TeamDeleteSuccessData = {
    teamId: string;
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
    organization_id: string | null;
    team_id: string | null;
    team_name: string | null;
    scope: "organization" | "team" | "private";
    files: GraphFileListItem[];
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

export type TeamCreateResponse = ApiResponse<
    TeamCreateSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_TEAM_MEMBERS" | "INTERNAL_SERVER_ERROR"
>;

export type TeamListResponse = ApiResponse<TeamListItem[], "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR">;

export type TeamUsersResponse = ApiResponse<
    TeamUserListItem[],
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INVALID_TEAM_MEMBERS" | "INTERNAL_SERVER_ERROR"
>;

export type TeamAvailableUsersResponse = ApiResponse<
    OrganizationMemberListItem[],
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPatchResponse = ApiResponse<
    TeamPatchSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INVALID_TEAM_MEMBERS" | "INTERNAL_SERVER_ERROR"
>;

export type TeamDeleteResponse = ApiResponse<
    TeamDeleteSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type GraphDetailResponse = ApiResponse<
    GraphDetailSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "TEAM_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphListResponse = ApiResponse<GraphListItem[], "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR">;

export type GraphFilesResponse = ApiResponse<
    GraphFileListItem[],
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "TEAM_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphCreateResponse = ApiResponse<
    GraphCreateSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "TEAM_NOT_FOUND"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphPatchResponse = ApiResponse<
    GraphPatchSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_NAME"
    | "NO_CHANGES"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphAddFilesResponse = ApiResponse<
    GraphAddFilesSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "NO_CHANGES" | "INTERNAL_SERVER_ERROR"
>;

export type GraphDeleteFilesResponse = ApiResponse<
    GraphDeleteFilesSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
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
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_FILE_IDS"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphDeleteResponse = ApiResponse<
    GraphDeleteSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
>;

export type TextUnitResponse = ApiResponse<
    TextUnitRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "TEXT_UNIT_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;

export type SourceReferenceResponse = ApiResponse<
    SourceReferenceRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "SOURCE_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;

export type SourceReferenceBatchResponse = ApiResponse<
    SourceReferenceBatchSuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
>;

export type ChatListResponse = ApiResponse<
    ChatListSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "CHAT_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;

export type ChatDetailResponse = ApiResponse<
    ChatHistoryRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "CHAT_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;

export type ChatCreateResponse = ApiResponse<
    ChatCreateSuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_CHAT_REQUEST"
    | "CHAT_NOT_FOUND"
    | "CHAT_CONTEXT_TOO_LARGE"
    | "INTERNAL_SERVER_ERROR"
>;

export type PromptListResponse = ApiResponse<
    PromptRecord[],
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "TEAM_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;

export type PromptCreateResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "TEAM_NOT_FOUND"
    | "INVALID_PROMPT"
    | "PROMPT_LIMIT_EXCEEDED"
    | "INTERNAL_SERVER_ERROR"
>;

export type PromptPatchResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "TEAM_NOT_FOUND"
    | "PROMPT_NOT_FOUND"
    | "INVALID_PROMPT"
    | "INTERNAL_SERVER_ERROR"
>;

export type PromptDeleteResponse = ApiResponse<
    null,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "TEAM_NOT_FOUND"
    | "PROMPT_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;

export type SearchResponse = ApiResponse<SearchSuccessData, "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR">;

export type ChatLibraryItem = SearchChatItem & {
    updatedAt: string | null;
};

export type ChatLibrarySuccessData = {
    items: ChatLibraryItem[];
    hasMore: boolean;
};

export type PinnedChatsResponse = ApiResponse<
    ChatLibrarySuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;

export type ArchivedChatsResponse = ApiResponse<
    ChatLibrarySuccessData,
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;
