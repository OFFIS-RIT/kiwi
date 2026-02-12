/**
 * API module - centralized exports for all API functions
 */

// Re-export client utilities
export { apiClient, ApiError, AUTH_TOKEN, streamSSERequest } from "./client";
export type { SSEFrame } from "./client";

// Re-export groups API
export {
  createGroup,
  deleteGroup,
  fetchGroups,
  fetchGroupUsers,
  fetchProjects,
  updateGroup,
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
  ApiConversationSummary,
  ApiGroup,
  ApiGroupUser,
  ApiGroupWithProjects,
  ApiProject,
  ApiProjectFile,
  ApiProjectQueryRequest,
  ApiProjectQueryResponse,
  ApiQueryMetrics,
  ApiResponseData,
  ApiTextUnit,
  ApiTextUnitResponse,
  QueryMode,
} from "@/types/api";
