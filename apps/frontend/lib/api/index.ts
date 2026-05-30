/**
 * API module - centralized exports for all API functions
 */

// Re-export client utilities
export { ApiError, createKiwiApiClient, unwrapApiResponse } from "./client";
export type { KiwiApiClient } from "./client";
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
    TeamAvailableUsersResponse,
    TeamCreateResponse,
    TeamDeleteResponse,
    TeamListResponse,
    TeamUsersResponse,
    TeamPatchResponse,
    SourceReferenceResponse,
    TextUnitResponse,
} from "@kiwi/api/types";

// Re-export team API helpers under the existing frontend group names.
export {
    addGroupUser,
    createGroup,
    deleteGroup,
    fetchGraphs,
    fetchGroups,
    fetchGroupAvailableUsers,
    fetchGroupUsers,
    removeGroupUser,
    updateGroup,
    updateGroupUsers,
} from "./groups";

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
    fetchSourceReference,
    fetchTextUnit,
    getApiAssetUrl,
    getProjectFileUrl,
    updateProject,
} from "./projects";

// Re-export types for convenience
export type {
    ApiGraph,
    ApiGroup,
    ApiGroupUser,
    ApiProjectFile,
    ApiSourceReference,
    ApiTextUnit,
    ApiTextUnitResponse,
} from "@/types/api";
