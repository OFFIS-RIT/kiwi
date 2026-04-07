/**
 * API module - centralized exports for all API functions
 */

// Re-export client utilities
export { apiClient, ApiError, streamSSERequest } from "./client";
export type { SSEFrame } from "./client";
export type {
    ApiErrorCode,
    BaseResponse,
    ErrorResponse,
    GraphFilesResponse,
    GraphListResponse,
    SuccessfulResponse,
    GraphCreateResponse,
    GraphDeleteResponse,
    GraphDetailResponse,
    GraphPatchResponse,
    GroupCreateResponse,
    GroupDeleteResponse,
    GroupListResponse,
    GroupUsersResponse,
    GroupPatchResponse,
    TextUnitResponse,
} from "@kiwi/api/types";

// Re-export groups API
export { createGroup, deleteGroup, fetchGraphs, fetchGroups, fetchGroupUsers, updateGroup } from "./groups";

// Re-export projects API
export {
    addFilesToProject,
    createProject,
    deleteProject,
    deleteProjectChat,
    deleteProjectFiles,
    downloadProjectFile,
    fetchProjectChat,
    fetchProjectChats,
    fetchProjectDetail,
    fetchProjectFiles,
    fetchTextUnit,
    queryProject,
    queryProjectStream,
    updateProject,
} from "./projects";
export type { StreamEventHandlers } from "./projects";

// Re-export types for convenience
export type {
    ApiChatHistoryMessage,
    ApiChatHistoryResponse,
    ApiClientToolCall,
    ApiGraph,
    ApiConversationSummary,
    ApiGroup,
    ApiGroupUser,
    ApiGroupWithProjects,
    ApiProjectFile,
    ApiProjectQueryRequest,
    ApiProjectQueryResponse,
    ApiQueryMetrics,
    ApiResponseData,
    ApiTextUnit,
    ApiTextUnitResponse,
    QueryMode,
} from "@/types/api";
