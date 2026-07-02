import type { ChatUIMessage } from "./chat";
import type { FileTypeDocumentMode, FileTypeValue } from "./file-types";
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

export const FILE_PROCESS_ERROR_CODE_VALUES = [
    "UNSUPPORTED_FILE_TYPE",
    "INVALID_FILE_FORMAT",
    "PASSWORD_PROTECTED_FILE",
    "NO_READABLE_TEXT",
    "FILE_TOO_LARGE_OR_COMPLEX",
    "OCR_REQUIRED_UNAVAILABLE",
    "EXTRACTION_FAILED",
    "SOURCE_FILE_MISSING",
    "INTERNAL_SERVER_ERROR",
] as const;
export type FileProcessErrorCode = (typeof FILE_PROCESS_ERROR_CODE_VALUES)[number];

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
    process_error_code: FileProcessErrorCode | null;
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
    has_failed_files: boolean;
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
          modelId?: string;
      }
    | {
          id: string;
          messages: ChatUIMessage[];
          deep?: boolean;
          modelId?: string;
      };

export const AI_MODEL_TYPE_VALUES = ["text", "subagent", "extract", "embedding", "image", "audio", "video"] as const;
export type AiModelType = (typeof AI_MODEL_TYPE_VALUES)[number];

export const AI_MODEL_ADAPTER_VALUES = ["openai", "azure", "anthropic", "openaiAPI"] as const;
export type AiModelAdapter = (typeof AI_MODEL_ADAPTER_VALUES)[number];

export type PublicModelListItem = {
    model_id: string;
    display_name: string;
    is_default: boolean;
};

export type AdminModelListItem = PublicModelListItem & {
    type: AiModelType;
    adapter: AiModelAdapter;
    provider_model: string;
    context_window: number;
    // Non-secret connection config; readable by admins, unlike the API key.
    url: string | null;
    resource_name: string | null;
    created_at: string;
    updated_at: string;
};

export type ModelListSuccessData = PublicModelListItem[] | AdminModelListItem[];

export type ModelCredentialsInput = {
    apiKey: string;
    url?: string;
    resourceName?: string;
};

export type ModelCreateInput = {
    model_id: string;
    display_name: string;
    type: AiModelType;
    adapter: AiModelAdapter;
    provider_model: string;
    context_window?: number;
    credentials: ModelCredentialsInput;
    is_default?: boolean;
};

// On PATCH every credential field is optional: omitted fields keep their
// stored value, an empty url/resourceName clears it.
export type ModelCredentialsPatchInput = {
    apiKey?: string;
    url?: string;
    resourceName?: string;
};

export type ModelPatchInput = {
    display_name?: string;
    adapter?: AiModelAdapter;
    provider_model?: string;
    context_window?: number;
    credentials?: ModelCredentialsPatchInput;
};

export const MODEL_TEST_FAILURE_REASON_VALUES = ["auth", "not_found", "unreachable", "unknown"] as const;
export type ModelTestFailureReason = (typeof MODEL_TEST_FAILURE_REASON_VALUES)[number];

export type ModelTestResult = { ok: true } | { ok: false; reason: ModelTestFailureReason; message: string };

// Like ModelCredentialsPatchInput, the API key is optional: when omitted the
// backend reuses the stored key of the model referenced by model_id.
export type ModelTestCredentialsInput = {
    apiKey?: string;
    url?: string;
    resourceName?: string;
};

export type ModelTestInput = {
    model_id?: string;
    type: AiModelType;
    adapter: AiModelAdapter;
    provider_model: string;
    credentials: ModelTestCredentialsInput;
};

export type FileTypeConfigRecord = {
    file_type: FileTypeValue;
    loader: string;
    chunker: string;
    chunk_size: number | null;
    document_mode: FileTypeDocumentMode | null;
    chunk_size_editable: boolean;
    document_mode_editable: boolean;
};

export type FileTypeConfigPatchInput = {
    chunk_size?: number;
    document_mode?: FileTypeDocumentMode;
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

export type SearchGraphChatItem = {
    id: string;
    title: string;
    isPinned: boolean;
    targetType: "graph";
    projectId: string;
    projectName: string;
    scope: "organization" | "team" | "private";
    teamId: string | null;
    teamName: string | null;
};

export type SearchTeamChatItem = {
    id: string;
    title: string;
    isPinned: boolean;
    targetType: "team";
    projectId: null;
    projectName: null;
    scope: "team";
    teamId: string;
    teamName: string;
};

export type SearchChatItem = SearchGraphChatItem | SearchTeamChatItem;

export type SearchSuccessData = {
    projects: SearchProjectItem[];
    teams: SearchTeamItem[];
    chats: SearchChatItem[];
};

export type PromptRecord = {
    id: string;
    prompt: string;
    created_at: string;
    updated_at: string;
};

export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_PROMPTS_PER_SCOPE = 5;

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

export type GraphFileRetrySuccessData = {
    graph: GraphRecord;
    fileId: string;
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

export type GraphSuggestionKind = "source_correction" | "entity_addition";
export type GraphSuggestionStatus = "pending" | "applied";

export type GraphSuggestionRecord = {
    id: string;
    graph_id: string;
    kind: GraphSuggestionKind;
    status: GraphSuggestionStatus;
    source_id: string | null;
    entity_id: string | null;
    reference: string;
    suggestion: string;
    suggested_by_user_id: string;
    chat_id: string | null;
    message_id: string | null;
    applied_by_user_id: string | null;
    applied_source_id: string | null;
    applied_at: string | null;
    created_at: string;
    updated_at: string;
};

export type GraphSuggestionApplySuccessData = {
    suggestion: GraphSuggestionRecord;
    sourceId: string;
    workflowRunId: string | null;
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
    | "UNSUPPORTED_FILE_TYPE"
    | "UPLOAD_LIMIT_EXCEEDED"
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
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "UNSUPPORTED_FILE_TYPE"
    | "UPLOAD_LIMIT_EXCEEDED"
    | "NO_CHANGES"
    | "INTERNAL_SERVER_ERROR"
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

export type GraphFileRetryResponse = ApiResponse<
    GraphFileRetrySuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_FILE_IDS"
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

export type GraphSuggestionListResponse = ApiResponse<
    GraphSuggestionRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
>;

export type GraphSuggestionDeleteResponse = ApiResponse<
    null,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "SUGGESTION_NOT_FOUND"
    | "INVALID_SUGGESTION"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphSuggestionApplyResponse = ApiResponse<
    GraphSuggestionApplySuccessData,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "SUGGESTION_NOT_FOUND"
    | "INVALID_SUGGESTION"
    | "SOURCE_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
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

export type FileTypeConfigListResponse = ApiResponse<
    FileTypeConfigRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;

export type FileTypeConfigPatchResponse = ApiResponse<
    FileTypeConfigRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "FILE_TYPE_NOT_FOUND"
    | "INVALID_FILE_TYPE_CONFIG"
    | "NO_CHANGES"
    | "INTERNAL_SERVER_ERROR"
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

export type UserPromptListResponse = ApiResponse<
    PromptRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPromptListResponse = ApiResponse<
    PromptRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type GraphPromptListResponse = ApiResponse<
    PromptRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "GRAPH_NOT_FOUND" | "INVALID_GRAPH_OWNER" | "INTERNAL_SERVER_ERROR"
>;

export type UserPromptCreateResponse = ApiResponse<
    PromptRecord,
    "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_PROMPT" | "PROMPT_LIMIT_EXCEEDED" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPromptCreateResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "TEAM_NOT_FOUND"
    | "INVALID_PROMPT"
    | "PROMPT_LIMIT_EXCEEDED"
    | "INTERNAL_SERVER_ERROR"
>;

export type GraphPromptCreateResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "INVALID_PROMPT"
    | "PROMPT_LIMIT_EXCEEDED"
    | "INTERNAL_SERVER_ERROR"
>;

export type UserPromptPatchResponse = ApiResponse<
    PromptRecord,
    "UNAUTHORIZED" | "FORBIDDEN" | "PROMPT_NOT_FOUND" | "INVALID_PROMPT" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPromptPatchResponse = ApiResponse<
    PromptRecord,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "PROMPT_NOT_FOUND" | "INVALID_PROMPT" | "INTERNAL_SERVER_ERROR"
>;

export type GraphPromptPatchResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "PROMPT_NOT_FOUND"
    | "INVALID_PROMPT"
    | "INTERNAL_SERVER_ERROR"
>;

export type UserPromptDeleteResponse = ApiResponse<
    null,
    "UNAUTHORIZED" | "FORBIDDEN" | "PROMPT_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type TeamPromptDeleteResponse = ApiResponse<
    null,
    "UNAUTHORIZED" | "FORBIDDEN" | "TEAM_NOT_FOUND" | "PROMPT_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type GraphPromptDeleteResponse = ApiResponse<
    null,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "GRAPH_NOT_FOUND"
    | "INVALID_GRAPH_OWNER"
    | "PROMPT_NOT_FOUND"
    | "INTERNAL_SERVER_ERROR"
>;

export type OrganizationPromptListResponse = ApiResponse<
    PromptRecord[],
    "UNAUTHORIZED" | "FORBIDDEN" | "ORGANIZATION_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
>;

export type OrganizationPromptCreateResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "ORGANIZATION_NOT_FOUND"
    | "INVALID_PROMPT"
    | "PROMPT_LIMIT_EXCEEDED"
    | "INTERNAL_SERVER_ERROR"
>;

export type OrganizationPromptPatchResponse = ApiResponse<
    PromptRecord,
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "ORGANIZATION_NOT_FOUND"
    | "PROMPT_NOT_FOUND"
    | "INVALID_PROMPT"
    | "INTERNAL_SERVER_ERROR"
>;

export type OrganizationPromptDeleteResponse = ApiResponse<
    null,
    "UNAUTHORIZED" | "FORBIDDEN" | "ORGANIZATION_NOT_FOUND" | "PROMPT_NOT_FOUND" | "INTERNAL_SERVER_ERROR"
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
