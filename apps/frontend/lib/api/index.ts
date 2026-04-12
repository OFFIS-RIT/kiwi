/**
 * API module - centralized exports for all API functions
 */

// Re-export client utilities
export { apiClient, ApiError, streamSSERequest } from "./client";
export type { SSEFrame } from "./client";
export type {
    ApiErrorCode,
    BaseResponse,
    ChatCreateResponse,
    ChatDetailResponse,
    ChatHistoryRecord,
    ChatListResponse,
    ChatRequestBody,
    ChatSummaryItem,
    ErrorResponse,
    GraphAddFilesResponse,
    GraphFilesResponse,
    GraphListResponse,
    SuccessfulResponse,
    GraphCreateResponse,
    GraphDeleteFilesResponse,
    GraphDeleteResponse,
    GraphDetailResponse,
    GraphFileDownloadResponse,
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
    updateProject,
} from "./projects";

// Re-export types for convenience
export type {
    ApiGraph,
    ApiGroup,
    ApiGroupUser,
    ApiProjectFile,
    ApiTextUnit,
    ApiTextUnitResponse,
} from "@/types/api";
