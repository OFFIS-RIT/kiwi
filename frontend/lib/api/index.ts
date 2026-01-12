/**
 * API module - centralized exports for all API functions
 */

// Re-export client utilities
export { apiClient, ApiError, AUTH_TOKEN, streamRequest } from "./client";

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
  deleteProjectFiles,
  downloadProjectFile,
  fetchProjectFiles,
  fetchTextUnit,
  queryProject,
  queryProjectStream,
  updateProject,
} from "./projects";

// Re-export types for convenience
export type {
  ApiChatMessage,
  ApiGroup,
  ApiGroupUser,
  ApiGroupWithProjects,
  ApiProject,
  ApiProjectFile,
  ApiQueryResponse,
  ApiTextUnit,
  ApiTextUnitResponse,
  QueryMode,
} from "@/types/api";
